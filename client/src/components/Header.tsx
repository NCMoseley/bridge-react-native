export function Header() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <h1 className="text-xl font-bold text-indigo-700">Bridge Dashboard</h1>
        <nav className="flex gap-4 text-sm text-slate-600">
          <a href="#" className="hover:text-indigo-600">
            Status
          </a>
          <a href="#" className="hover:text-indigo-600">
            Settings
          </a>
        </nav>
      </div>
    </header>
  )
}
