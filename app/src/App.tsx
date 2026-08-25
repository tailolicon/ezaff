import { useEffect, useState } from 'react'
import { Library } from './pages/Library'
import { Settings, type SettingsTab } from './pages/Settings'
import { WelcomeGate } from './components/WelcomeGate'
import { installDropNavigationGuard } from './lib/fileDrop'

type Page = 'library' | 'settings'

export function App() {
  const [page, setPage] = useState<Page>('library')
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('templates')

  // Dropping a file anywhere else would otherwise navigate the app to it.
  useEffect(() => installDropNavigationGuard(), [])

  return (
    <div className="app">
      {page === 'library' ? (
        <Library
          onOpenSettings={(tab) => {
            if (tab) setSettingsTab(tab)
            setPage('settings')
          }}
        />
      ) : (
        <Settings
          tab={settingsTab}
          onTabChange={setSettingsTab}
          onBack={() => setPage('library')}
        />
      )}
      <WelcomeGate />
    </div>
  )
}
