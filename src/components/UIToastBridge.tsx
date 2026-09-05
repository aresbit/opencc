/**
 * <ToastBridge> — forwards plugin-requested toasts into the real
 * in-TUI notification queue. Mount once near the app root.
 *
 * requestToast() runs from inside an async hook handler with no React
 * involved, so it can't call useNotifications() itself; this is the only
 * component that does, translating each request into addNotification().
 */

import { useEffect } from 'react'
import { useNotifications } from '../context/notifications.js'
import { subscribeToasts, type ToastRequest } from '../services/functionHooks/uiDispatcher.js'
import type { Theme } from '../utils/theme.js'

export function ToastBridge(): null {
  const { addNotification } = useNotifications()

  useEffect(() => {
    return subscribeToasts((t: ToastRequest) => {
      addNotification({
        key: t.key,
        priority: t.priority ?? 'low',
        timeoutMs: t.timeoutMs,
        text: t.text,
        color: t.color as keyof Theme | undefined,
      })
    })
  }, [addNotification])

  return null
}
