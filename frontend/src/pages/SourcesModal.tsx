import { useEffect } from 'react';
import { t } from '../lib/i18n';
import './SourcesModal.css';

export interface SourceItem {
  index:   number;
  title:   string;
  snippet: string;
  url:     string;
}

interface Props {
  sources: SourceItem[];
  lang:    'id' | 'en' | null;
  onClose: () => void;
}

export default function SourcesModal({ sources, lang, onClose }: Props) {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  return (
    <div className="srm-overlay" onClick={onClose}>
      <div className="srm-panel" onClick={(e) => e.stopPropagation()}>
        <div className="srm-header">
          <span className="srm-title">{t('srmTitle', lang, { count: sources.length })}</span>
          <button className="srm-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="srm-grid">
          {sources.map((s) => (
            <div key={s.index} className="srm-card">
              <span className="srm-card-index">{s.index}</span>
              <h3 className="srm-card-headline">{s.title}</h3>
              <div className="srm-card-snippet-wrap">
                <p className="srm-card-snippet">{s.snippet}{s.snippet.endsWith('...') ? '' : '...'}</p>
                <div className="srm-card-fade" />
              </div>
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="srm-card-btn">
                {t('srmOpenSource', lang)}
              </a>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
