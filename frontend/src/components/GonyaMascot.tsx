import './GonyaMascot.css';

export type GonyaState = 'idle' | 'sleeping' | 'walking' | 'happy' | 'worried' | 'sad' | 'focused' | 'peeking' | 'muttering';

interface Props {
  state?:  GonyaState;
  size?:   number | string;
  className?: string;
}

export default function GonyaMascot({ state = 'idle', size = 280, className = '' }: Props) {
  return (
    <div
      className={`gonya-mascot gonya-state-${state} ${className}`}
      style={{ width: size, height: size }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="150 90 520 520"
        width="100%"
        height="100%"
      >
        <defs>
          <linearGradient id="gm-frontGrad" x1="20%" y1="0%" x2="80%" y2="100%">
            <stop offset="0%" stopColor="#64829E" />
            <stop offset="100%" stopColor="#2C3E50" />
          </linearGradient>
          <linearGradient id="gm-sideGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#3A4F65" />
            <stop offset="100%" stopColor="#1C2836" />
          </linearGradient>
          <filter id="gm-heavyGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="60" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="gm-coreGlow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="12" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Soul / Ambient Light */}
        <circle className="gm-soul" cx="420" cy="330" r="160"
          fill="#FFB347" opacity="0.35" filter="url(#gm-heavyGlow)" />

        {/* Outer Tendrils */}
        <path d="M 280 400 C 180 480, 160 370, 220 350"
          fill="none" stroke="#253545" strokeWidth="22" strokeLinecap="round" />
        <path d="M 570 410 C 670 480, 680 380, 620 360"
          fill="none" stroke="#253545" strokeWidth="22" strokeLinecap="round" />

        {/* Body */}
        <g className="gm-body">
          <path d="M 370 110 C 400 110, 420 125, 435 150 L 585 390 C 605 425, 580 460, 540 460 L 240 460 C 210 460, 190 435, 205 410 L 325 160 C 340 130, 360 110, 370 110 Z"
            fill="url(#gm-sideGrad)" />
          <path d="M 290 230 L 230 350" fill="none" stroke="#FFE2B2"
            strokeWidth="16" strokeLinecap="round" filter="url(#gm-coreGlow)" opacity="0.9" />
          <path d="M 290 230 L 230 350" fill="none" stroke="#FFFFFF"
            strokeWidth="6" strokeLinecap="round" />
          <path d="M 380 125 L 410 125" fill="none" stroke="#FFE2B2"
            strokeWidth="10" strokeLinecap="round" filter="url(#gm-coreGlow)" opacity="0.9" />
          <path d="M 400 130 C 430 130, 450 145, 465 170 L 615 410 C 635 445, 610 480, 570 480 L 270 480 C 240 480, 220 455, 235 430 L 355 180 C 370 150, 390 130, 400 130 Z"
            fill="url(#gm-frontGrad)" />
          <path d="M 400 138 C 425 138, 440 150, 452 173 L 598 410 C 613 438, 595 468, 563 468 L 277 468 C 250 468, 238 445, 248 425 L 366 186 C 378 160, 390 138, 400 138 Z"
            fill="none" stroke="#ffffff" strokeWidth="2.5" opacity="0.4" />
        </g>

        {/* Left Tendril */}
        <g className="gm-tendril-left">
          <path d="M 330 470 C 280 550, 400 580, 410 500"
            fill="none" stroke="#32465C" strokeWidth="20" strokeLinecap="round" />
          <path d="M 330 470 C 280 550, 400 580, 410 500"
            fill="none" stroke="#64829E" strokeWidth="3" strokeLinecap="round"
            opacity="0.5" transform="translate(-1,-3)" />
        </g>

        {/* Right Tendril */}
        <g className="gm-tendril-right">
          <path d="M 520 470 C 560 550, 440 580, 430 500"
            fill="none" stroke="#32465C" strokeWidth="20" strokeLinecap="round" />
          <path d="M 520 470 C 560 550, 440 580, 430 500"
            fill="none" stroke="#64829E" strokeWidth="3" strokeLinecap="round"
            opacity="0.5" transform="translate(1,-3)" />
        </g>

        {/* Left Eye */}
        <g className="gm-eye-left">
          <circle cx="395" cy="310" r="48" fill="#FFE2B2" filter="url(#gm-coreGlow)" />
          <circle className="gm-eye-left-inner" cx="395" cy="310" r="38" fill="#FFF7E6" />
          {/* Sleeping line — hidden by default, visible in sleeping state */}
          <line className="gm-sleep-line-left"
            x1="360" y1="310" x2="430" y2="310"
            stroke="#FFE2B2" strokeWidth="8" strokeLinecap="round" />
        </g>

        {/* Right Eye */}
        <g className="gm-eye-right">
          <circle cx="530" cy="325" r="32" fill="#FFE2B2" filter="url(#gm-coreGlow)" />
          <circle className="gm-eye-right-inner" cx="530" cy="325" r="24" fill="#FFF7E6" />
          <line className="gm-sleep-line-right"
            x1="508" y1="325" x2="552" y2="325"
            stroke="#FFE2B2" strokeWidth="6" strokeLinecap="round" />
        </g>

        {/* Smile */}
        <g className="gm-smile">
          <path d="M 455 390 Q 480 415 505 395"
            fill="none" stroke="#FFE2B2" strokeWidth="11"
            strokeLinecap="round" filter="url(#gm-coreGlow)" />
          <path className="gm-smile-inner"
            d="M 455 390 Q 480 415 505 395"
            fill="none" stroke="#FFF7E6" strokeWidth="5" strokeLinecap="round" />
        </g>

        {/* Zzz — visible only in sleeping state */}
        <g className="gm-zzz">
          <text x="560" y="260" fill="#FFE2B2" fontSize="28" fontFamily="monospace"
            opacity="0.9">z</text>
          <text x="585" y="230" fill="#FFE2B2" fontSize="22" fontFamily="monospace"
            opacity="0.7">z</text>
          <text x="605" y="205" fill="#FFE2B2" fontSize="16" fontFamily="monospace"
            opacity="0.5">z</text>
        </g>

        {/* Grumble dots — visible only in muttering state */}
        <g className="gm-grumble">
          <circle cx="518" cy="378" r="5.5" fill="#FFE2B2" />
          <circle cx="533" cy="371" r="4.5" fill="#FFE2B2" />
          <circle cx="546" cy="366" r="3.5" fill="#FFE2B2" />
        </g>

      </svg>
    </div>
  );
}