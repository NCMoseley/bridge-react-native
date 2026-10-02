import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { playToastSound } = vi.hoisted(() => ({ playToastSound: vi.fn() }))

vi.mock('../utils/alertSound', () => ({
  playAlertBeep: vi.fn(),
  playToastSound,
  unlockAlertAudio: vi.fn(),
}))

import { ToastProvider } from './ToastContext'

class TestEventSource {
  static instance: TestEventSource | undefined
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()

  constructor(_url: string) {
    TestEventSource.instance = this
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string, data: string) {
    const event = new MessageEvent(type, { data })
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event)
      else listener.handleEvent(event)
    }
  }

  close() {}
}

describe('ToastProvider SSE success sound', () => {
  beforeEach(() => {
    TestEventSource.instance = undefined
    playToastSound.mockClear()
    vi.stubGlobal('EventSource', TestEventSource)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('keeps silent success toasts visible without playing the sound', async () => {
    render(<ToastProvider><div /></ToastProvider>)
    await waitFor(() => expect(TestEventSource.instance).toBeDefined())
    const message = 'CrossTrade dispatch confirmed working at NT8.'
    act(() => TestEventSource.instance!.emit('toast:success', JSON.stringify({ message, silent: true })))

    expect(await screen.findByText(message)).toBeTruthy()
    expect(playToastSound).not.toHaveBeenCalled()
  })

  it('continues playing the sound for ordinary success toasts', async () => {
    render(<ToastProvider><div /></ToastProvider>)
    await waitFor(() => expect(TestEventSource.instance).toBeDefined())
    act(() => TestEventSource.instance!.emit('toast:success', JSON.stringify({ message: 'Other success' })))

    expect(await screen.findByText('Other success')).toBeTruthy()
    expect(playToastSound).toHaveBeenCalledOnce()
    expect(playToastSound).toHaveBeenCalledWith('success')
  })
})
