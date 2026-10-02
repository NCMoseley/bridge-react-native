import { Button } from './components/Button'
import { Input } from './components/Input'
import { Card } from './components/Card'
import { Badge } from './components/Badge'
import { Header } from './components/Header'

function App() {
  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <main className="mx-auto max-w-5xl p-6">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold text-slate-900">Tradovate Bridge</h2>
          <Badge status="online">Connected</Badge>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <Card title="Connection">
            <p className="mb-4 text-sm text-slate-600">
              Manage the bridge connection to your Tradovate account.
            </p>
            <div className="flex gap-3">
              <Button variant="primary">Connect</Button>
              <Button variant="secondary">Disconnect</Button>
            </div>
          </Card>

          <Card title="API Key">
            <div className="space-y-4">
              <Input label="API Key" placeholder="Enter your API key" />
              <Button variant="primary" className="w-full">
                Save
              </Button>
            </div>
          </Card>

          <Card title="Recent Activity">
            <ul className="space-y-2 text-sm text-slate-700">
              <li className="flex justify-between border-b border-slate-100 pb-2">
                <span>Order placed</span>
                <span className="text-slate-400">2 min ago</span>
              </li>
              <li className="flex justify-between border-b border-slate-100 pb-2">
                <span>Connection refreshed</span>
                <span className="text-slate-400">15 min ago</span>
              </li>
            </ul>
          </Card>

          <Card title="System">
            <p className="text-sm text-slate-600">Version 0.1.4</p>
            <div className="mt-4">
              <Badge status="warning">Pending update</Badge>
            </div>
          </Card>
        </div>
      </main>
    </div>
  )
}

export default App
