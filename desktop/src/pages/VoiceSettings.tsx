import { useEffect, useState } from 'react'
import { useTranslation } from '../i18n'
import { useSettingsStore } from '../stores/settingsStore'
import { getDesktopHost } from '../lib/desktopHost'
import { Input } from '../components/shared/Input'
import { Button } from '../components/shared/Button'
import type { VoiceSettings, VoiceSpeakMode } from '../types/settings'

const SPEAK_MODES: { value: VoiceSpeakMode; key: 'voice.speakMode.off' | 'voice.speakMode.lastText' | 'voice.speakMode.shortOnly' }[] = [
  { value: 'lastText', key: 'voice.speakMode.lastText' },
  { value: 'shortOnly', key: 'voice.speakMode.shortOnly' },
  { value: 'off', key: 'voice.speakMode.off' },
]

export function VoiceSettings() {
  const t = useTranslation()
  const voice = useSettingsStore((state) => state.voice)
  const setVoice = useSettingsStore((state) => state.setVoice)

  const capable = getDesktopHost().capabilities.voice
  const [draft, setDraft] = useState<VoiceSettings>(voice)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  useEffect(() => {
    setDraft(voice)
  }, [voice])

  const update = (patch: Partial<VoiceSettings>) => {
    setDraft((prev) => ({ ...prev, ...patch }))
    setSaved(false)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await setVoice(draft)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    if (!capable) return
    if (!draft.apiKey.trim()) {
      setTestResult(t('voice.testMissingKey'))
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const host = getDesktopHost()
      const { audio, mime } = await host.voice.synthesize({
        apiKey: draft.apiKey,
        ttsResourceId: draft.ttsResourceId,
        speaker: draft.speaker,
        text: t('voice.testPhrase'),
        format: 'mp3',
      })
      const blob = new Blob([audio], { type: mime })
      const url = URL.createObjectURL(blob)
      const audioEl = new Audio(url)
      audioEl.onended = () => URL.revokeObjectURL(url)
      await audioEl.play()
      setTestResult(t('voice.testOk'))
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : t('voice.testFailed'))
    } finally {
      setTesting(false)
    }
  }

  if (!capable) {
    return (
      <div className="flex min-h-[min(720px,calc(100vh-8rem))] flex-col">
        <h2 className="mb-2 text-base font-semibold text-[var(--color-text-primary)]">
          {t('settings.tab.voice')}
        </h2>
        <div className="flex flex-1 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-8 text-center">
          <div>
            <span className="material-symbols-outlined mb-3 block text-[32px] text-[var(--color-text-tertiary)]">
              desktop_windows
            </span>
            <p className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('voice.unavailableTitle')}
            </p>
            <p className="mt-1 text-sm text-[var(--color-text-tertiary)]">
              {t('voice.unavailableBody')}
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-[min(720px,calc(100vh-8rem))] flex-col">
      <h2 className="mb-1 text-base font-semibold text-[var(--color-text-primary)]">
        {t('settings.tab.voice')}
      </h2>
      <p className="mb-5 text-sm text-[var(--color-text-secondary)]">
        {t('voice.description')}
      </p>

      <div className="flex flex-col gap-4">
        <ToggleRow
          label={t('voice.enableInput')}
          description={t('voice.enableInputDesc')}
          checked={draft.enabled}
          onChange={(value) => update({ enabled: value })}
        />

        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4">
          <div className="flex flex-col gap-4">
            <Input
              label={t('voice.apiKey')}
              type="password"
              autoComplete="off"
              placeholder={t('voice.apiKeyPlaceholder')}
              value={draft.apiKey}
              onChange={(event) => update({ apiKey: event.target.value })}
            />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Input
                label={t('voice.asrResourceId')}
                placeholder="volc.seedasr.sauc.duration"
                value={draft.asrResourceId}
                onChange={(event) => update({ asrResourceId: event.target.value })}
              />
              <Input
                label={t('voice.ttsResourceId')}
                placeholder="seed-tts-2.0"
                value={draft.ttsResourceId}
                onChange={(event) => update({ ttsResourceId: event.target.value })}
              />
            </div>
            <Input
              label={t('voice.speaker')}
              placeholder="zh_female_vv_uranus_bigtts"
              value={draft.speaker}
              onChange={(event) => update({ speaker: event.target.value })}
            />
          </div>
        </div>

        <ToggleRow
          label={t('voice.autoSend')}
          description={t('voice.autoSendDesc')}
          checked={draft.autoSend}
          onChange={(value) => update({ autoSend: value })}
        />

        <ToggleRow
          label={t('voice.ttsEnabled')}
          description={t('voice.ttsEnabledDesc')}
          checked={draft.ttsEnabled}
          onChange={(value) => update({ ttsEnabled: value })}
        />

        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4">
          <label htmlFor="voice-speak-mode" className="mb-1.5 block text-sm font-medium text-[var(--color-text-primary)]">
            {t('voice.speakMode')}
          </label>
          <p className="mb-2 text-xs text-[var(--color-text-tertiary)]">
            {t('voice.speakModeDesc')}
          </p>
          <select
            id="voice-speak-mode"
            value={draft.speakMode}
            onChange={(event) => update({ speakMode: event.target.value as VoiceSpeakMode })}
            className="h-10 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-border-focus)]"
          >
            {SPEAK_MODES.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {t(mode.key)}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div className="rounded-[var(--radius-md)] border border-[var(--color-error)]/20 bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]">
            {error}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" loading={saving} onClick={() => void handleSave()}>
            {t('voice.save')}
          </Button>
          {saved && (
            <span className="text-xs text-[var(--color-text-secondary)]">{t('voice.saved')}</span>
          )}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            loading={testing}
            onClick={() => void handleTest()}
          >
            {t('voice.test')}
          </Button>
          {testResult && (
            <span className="text-xs text-[var(--color-text-secondary)]">{testResult}</span>
          )}
        </div>

        <p className="text-xs text-[var(--color-text-tertiary)]">{t('voice.usageHint')}</p>
      </div>
    </div>
  )
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4">
      <span className="flex flex-col">
        <span className="text-sm font-medium text-[var(--color-text-primary)]">{label}</span>
        <span className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">{description}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]"
      />
    </label>
  )
}
