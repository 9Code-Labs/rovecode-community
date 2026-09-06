/** Windows process-TREE kill via a kernel Job Object (port #21 HIGH-1).
 *
 *  `taskkill /T` walks LIVE parent links. msys2 (Git bash) implements a
 *  Cygwin→Cygwin exec by handing the pid to the new image and exiting the
 *  forked stub, so the external command actually running inside a compound
 *  (`a; sleep N; b`), nested (`bash -c '…'`) or backgrounded (`x & y & wait`)
 *  shape has a DEAD Win32 parent and the walk never reaches it. Measured
 *  through bunRunner on the reference box with an msys `sleep` child: 3/3
 *  leaks + 3/3 runner hangs per shape (the orphan kept stdout open); only a
 *  bare `sleep N`, exec'd without a fork, died. A native child (bun.exe) stays
 *  reachable, which is why the shipped test passed. A Job Object records
 *  membership at CreateProcess time and inherits it down the tree, so
 *  TerminateJobObject kills every descendant regardless of parent links.
 *
 *  Per-spawn lifecycle (executor.ts bunRunner):
 *    createWinJob() → assign(launcherPid)   right after Bun.spawn
 *    abort  → terminate()                    TerminateJobObject, then close
 *    settle → release()                      a run that completed on its own:
 *             drop the close-kill limit, then close — a child the command
 *             deliberately left behind (`server > log 2>&1 &`) survives, as
 *             it does on POSIX and did before this port. While the command is
 *             in flight the limit stays armed, so an rovecode crash takes the
 *             tree with it (the OS closes the handle).
 *  assign() also sweeps the launcher's already-visible descendants by a
 *  Toolhelp32 parent-chain walk: a child forked in the spawn→assign window is
 *  not a member by inheritance (under load that window can span a scheduler
 *  quantum). Residual: a Cygwin stub that already exec'd AND exited inside
 *  that window leaves its child unreachable by any parent walk. The sweep
 *  costs one process snapshot (~15ms with ~300 processes on the loaded
 *  reference box).
 *  Fail-safe: non-win32, no bun:ffi, or any kernel32 call failing → null; the
 *  caller keeps `taskkill /T /F` alone and reports treeKill "taskkill-only".
 *  Nested jobs (Windows 8+) let this work when rovecode itself already runs
 *  inside a job (terminals and IDEs do that): the launcher is then in both. */

import { dlopen, FFIType, ptr } from "bun:ffi";

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JobObjectExtendedLimitInformation = 9;
/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on x64; LimitFlags sits at
 *  BasicLimitInformation offset 16 (after two LARGE_INTEGERs). */
const EXTENDED_LIMIT_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;
const PROCESS_SET_QUOTA_AND_TERMINATE = 0x0101;
const TH32CS_SNAPPROCESS = 0x2;
/** sizeof(PROCESSENTRY32W) on x64; th32ProcessID at 8, th32ParentProcessID at 32. */
const PE32_SIZE = 568;
const PE32_PID = 8;
const PE32_PPID = 32;

type Handle = number;

interface Kernel32 {
  CreateJobObjectW(attrs: null, name: null): Handle | null;
  SetInformationJobObject(job: Handle, cls: number, info: number, len: number): number;
  AssignProcessToJobObject(job: Handle, proc: Handle): number;
  TerminateJobObject(job: Handle, exitCode: number): number;
  OpenProcess(access: number, inherit: number, pid: number): Handle | null;
  CloseHandle(h: Handle): number;
  CreateToolhelp32Snapshot(flags: number, pid: number): Handle | null;
  Process32FirstW(snap: Handle, entry: number): number;
  Process32NextW(snap: Handle, entry: number): number;
}

let library: { symbols: unknown } | null | undefined; // undefined = not tried yet
let override: boolean | null = null;

function kernel32(): Kernel32 | null {
  if (library === undefined) {
    library = null;
    if (process.platform === "win32") {
      try {
        library = dlopen("kernel32.dll", {
          CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
          SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
          AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
          TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
          OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
          CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
          CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
          Process32FirstW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
          Process32NextW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        });
      } catch { library = null; }
    }
  }
  return library ? (library.symbols as Kernel32) : null;
}

/** A kernel HANDLE is a small positive value: NULL arrives as null and
 *  INVALID_HANDLE_VALUE (-1) fits this range in no representation. */
const isHandle = (h: unknown): h is Handle => typeof h === "number" && h > 0 && h <= 0xffff_ffff;

/** Whether the real Job Object path is usable here (status surfaces, tests). */
export function winJobsAvailable(): boolean { return override ?? kernel32() !== null; }

/** Test seam: `false` forces the fail-safe path (the box-without-kernel32
 *  shape — callers fall back to taskkill-only); `null` restores detection. */
export function overrideWinJobs(available: boolean | null): void { override = available; }

export interface WinJob {
  /** Put `pid` and its currently visible descendants in the job. false →
   *  nothing is a member (caller must fall back); the job is closed. */
  assign(pid: number): boolean;
  /** Abort: kill every member now, then close. Idempotent. */
  terminate(): void;
  /** Normal settle: clear the close-kill limit, then close — members that
   *  outlived the command keep running. No-op after terminate(). */
  release(): void;
}

/** One job per spawn, armed with KILL_ON_JOB_CLOSE. null = unavailable. */
export function createWinJob(): WinJob | null {
  if (override === false) return null;
  const k = kernel32();
  if (!k) return null;
  const job = k.CreateJobObjectW(null, null);
  if (!isHandle(job)) return null;
  const limits = new Uint8Array(EXTENDED_LIMIT_SIZE);
  new DataView(limits.buffer).setUint32(LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
  if (!k.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr(limits), EXTENDED_LIMIT_SIZE)) {
    k.CloseHandle(job);
    return null;
  }
  let handle: Handle | null = job;
  const close = (): void => { if (handle !== null) { k.CloseHandle(handle); handle = null; } };
  const assignOne = (pid: number): boolean => {
    if (handle === null) return false;
    const p = k.OpenProcess(PROCESS_SET_QUOTA_AND_TERMINATE, 0, pid);
    if (!isHandle(p)) return false;
    try { return k.AssignProcessToJobObject(handle, p) !== 0; } finally { k.CloseHandle(p); }
  };
  return {
    assign(pid) {
      if (!assignOne(pid)) { close(); return false; }
      // belt-and-braces for the spawn→assign window; already-member or
      // already-exited descendants simply fail to assign, which is fine
      for (const d of descendants(k, pid)) assignOne(d);
      return true;
    },
    terminate() {
      if (handle === null) return;
      k.TerminateJobObject(handle, 1);
      close();
    },
    release() {
      if (handle === null) return;
      k.SetInformationJobObject(handle, JobObjectExtendedLimitInformation, ptr(new Uint8Array(EXTENDED_LIMIT_SIZE)), EXTENDED_LIMIT_SIZE);
      close();
    },
  };
}

/** Live descendants of `root` by parent-pid chain (one Toolhelp32 snapshot).
 *  pids recycle, so a stale parent link could form a cycle: visited-set walk. */
function descendants(k: Kernel32, root: number): number[] {
  const snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!isHandle(snap)) return [];
  const children = new Map<number, number[]>();
  try {
    const entry = new Uint8Array(PE32_SIZE);
    const view = new DataView(entry.buffer);
    view.setUint32(0, PE32_SIZE, true); // dwSize must be set before Process32FirstW
    if (!k.Process32FirstW(snap, ptr(entry))) return [];
    do {
      const pid = view.getUint32(PE32_PID, true);
      const ppid = view.getUint32(PE32_PPID, true);
      const list = children.get(ppid);
      if (list) list.push(pid); else children.set(ppid, [pid]);
    } while (k.Process32NextW(snap, ptr(entry)));
  } finally {
    k.CloseHandle(snap);
  }
  const seen = new Set<number>([root]);
  const out: number[] = [];
  const stack = [root];
  while (stack.length > 0) {
    for (const c of children.get(stack.pop()!) ?? []) {
      if (!seen.has(c)) { seen.add(c); out.push(c); stack.push(c); }
    }
  }
  return out;
}
