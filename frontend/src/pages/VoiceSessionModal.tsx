import { t } from '../lib/i18n';
import './VoiceSessionModal.css';

interface VoiceTranscriptLine {
  speaker: string;
  text:    string;
}

interface Props {
  content:   string;
  transcript: VoiceTranscriptLine[];
  lang:      'id' | 'en' | null;
  onClose:   () => void;
}

export default function VoiceSessionModal({ content, transcript, lang, onClose }: Props) {
  return (
    <div className="vsm-overlay" onClick={onClose}>
      <div className="vsm-panel" onClick={(e) => e.stopPropagation()}>
        <div className="vsm-header">
          <span className="vsm-title">{content}</span>
          <button className="vsm-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="vsm-transcript">
          {transcript.length === 0 && (
            <div className="vsm-empty">{t('vsmEmpty', lang)}</div>
          )}
          {transcript.map((line, i) => (
            <div key={i} className={`vsm-line ${line.speaker === 'User' ? 'you' : 'agent'}`}>
              <span className="vsm-line-speaker">{line.speaker === 'User' ? t('csYou', lang) : line.speaker}</span>
              <span className="vsm-line-text">{line.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
