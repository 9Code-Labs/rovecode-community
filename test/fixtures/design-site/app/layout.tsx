// The root layout: the chrome a page never imports but always renders inside. Deliberately hairline-heavy —
// this is where the rules a real site draws actually live (nav, footer, section separators).
import { Nav } from "../components/nav";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <div className="border-b border-slate-200">
          <div className="border-r border-slate-200">
            <span className="border-l border-slate-200">a</span>
            <span className="border-t border-slate-200">b</span>
          </div>
        </div>
        <main>{children}</main>
        <footer className="border-t border-slate-200">
          <div className="border-b border-slate-200">
            <p className="border-b border-slate-200">c</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
