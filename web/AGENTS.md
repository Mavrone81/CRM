<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Mobile-first responsiveness is required for ALL UI

Every new view, component, or service must be responsive down to **375px** wide
(tablet checkpoint **768px**) without breaking the desktop layout. Build mobile-first:
base classes target mobile, scale up with `sm:`/`md:`/`lg:` prefixes.

- No horizontal page overflow at 375px. Intentional internal scroll (e.g. a kanban
  board) must live in an `overflow-x-auto` container so it never pushes the page.
- Multi-column grids/flex rows stack to one column on mobile (`grid-cols-1 md:grid-cols-*`).
- Toolbars/nav must wrap or scroll within themselves — never overflow the viewport.
- Modals: `w-full max-w-* ` inside padded overlay; inputs comfortably tappable.
- Tables: wrap in `overflow-auto`; hide non-essential columns with `hidden sm:table-cell`.
- After UI work, mentally verify the layout at 375 / 768 / 1280px.
