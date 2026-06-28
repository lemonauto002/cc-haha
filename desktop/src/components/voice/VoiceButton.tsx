import { useTranslation } from '../../i18n'

export type VoiceButtonProps = {
  /** Voice mode is armed: Space acts as push-to-talk. */
  armed: boolean
  isRecording: boolean
  isTranscribing: boolean
  error: string | null
  compact: boolean
  isMobile: boolean
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
}

export function VoiceButton({
  armed,
  isRecording,
  isTranscribing,
  error,
  compact,
  isMobile,
  onClick,
}: VoiceButtonProps) {
  const t = useTranslation()

  const icon = isTranscribing
    ? 'autorenew'
    : isRecording || armed
      ? 'mic'
      : 'mic_off'

  const title = error
    ? error
    : isTranscribing
      ? t('voice.transcribing')
      : isRecording
        ? t('voice.recordingHint')
        : armed
          ? t('voice.armedHint')
          : t('voice.enable')

  const accent = isRecording
    ? 'text-[var(--color-error)]'
    : armed
      ? 'text-[var(--color-brand)]'
      : 'text-[var(--color-text-secondary)]'

  const sizeClass = isMobile
    ? 'inline-flex h-11 w-11 items-center justify-center rounded-xl'
    : compact
      ? 'inline-flex h-8 w-8 items-center justify-center rounded-lg'
      : 'rounded-[var(--radius-md)] p-1.5'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isTranscribing}
      aria-label={title}
      title={title}
      className={`${accent} transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-50 ${sizeClass}`}
    >
      <span
        className={`material-symbols-outlined text-[18px] ${isRecording ? 'animate-pulse' : ''} ${isTranscribing ? 'animate-spin' : ''}`}
        aria-hidden="true"
      >
        {icon}
      </span>
    </button>
  )
}
