import { createBrowserRouter } from 'react-router-dom'
import { Layout } from './pages/Layout'
import { LoginPage } from './pages/LoginPage'
import { JournalPage } from './pages/Journal'
import { AccountsPage } from './pages/Accounts'
import { AccountPnlReviewPage } from './pages/AccountPnlReview'
import { AlertsPage } from './pages/Alerts'
import { RangesPage } from './pages/Ranges'
import { RangeCalendarPage } from './pages/RangeCalendarPage'
import { CategoryCalendarPage } from './pages/CategoryCalendarPage'
import { SettingsPage } from './pages/Settings'
import { DebuggingPage } from './pages/Debugging'
import { OrderReviewPage } from './pages/OrderReview'
import { MonitoringPage } from './pages/Monitoring'
import { RequireAdmin } from './components/RequireAdmin'

export const routes = [
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/app/*',
    element: <Layout />,
    children: [
      { index: true, element: <JournalPage /> },
      { path: 'journal/day', element: <JournalPage /> },
      { path: 'accounts', element: <AccountsPage /> },
      { path: 'accounts/:accountId/pnl', element: <AccountPnlReviewPage /> },
      { path: 'alerts', element: <AlertsPage /> },
      { path: 'ranges', element: <RangesPage /> },
      { path: 'ranges/calendar', element: <RangeCalendarPage /> },
      { path: 'categories/calendar', element: <CategoryCalendarPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'order-review', element: <OrderReviewPage /> },
      {
        path: 'debugging',
        element: (
          <RequireAdmin>
            <DebuggingPage />
          </RequireAdmin>
        ),
      },
      {
        path: 'monitoring',
        element: <MonitoringPage />,
      },
    ],
  },
]

export const router = createBrowserRouter(routes)
