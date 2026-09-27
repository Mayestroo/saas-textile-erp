import { useEffect, useState } from 'react'

function Versions(): React.JSX.Element {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true
    void window.erp.app
      .getVersion()
      .then((appVersion) => {
        if (isMounted) setVersion(appVersion)
      })
      .catch(() => {
        if (isMounted) setVersion(null)
      })
    return () => {
      isMounted = false
    }
  }, [])

  return <p className="app-version">Ilova versiyasi {version ? `v${version}` : '—'}</p>
}

export default Versions
