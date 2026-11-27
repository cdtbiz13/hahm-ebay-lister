import Link from "next/link";

const LINKS = [
  { href: "/source", label: "🔎 Source" },
  { href: "/intake", label: "📥 Intake" },
  { href: "/", label: "✍️ Listing" },
] as const;

/** Switch between the three screens. */
export function AppNav({ current }: { current: "/source" | "/intake" | "/" }) {
  return (
    <nav className="app-nav" aria-label="Screens">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={l.href === current ? "active" : undefined} aria-current={l.href === current ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
