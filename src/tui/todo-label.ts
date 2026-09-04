/** Tiny status-bar helper split from info-cmd.ts so app.ts can import it statically
 *  without pulling in the full info-cmd module at startup. */
import { loadTodos, todoStatusLabel } from "../tools/todo.ts";

export function todoLabel(sessionDir: string): string | undefined {
  return todoStatusLabel(loadTodos(sessionDir).items) || undefined;
}
