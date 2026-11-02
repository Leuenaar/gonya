'use strict';
/**
 * SAFETY CORE — Crisis Resource Directory
 *
 * CRITICAL: Never import this file from buildSystemPrompt() or any
 * context Aksel/Vera can read. Safety Core only.
 *
 * VERIFICATION LOG:
 * - LISA Helpline — REMOVED 2026-06. Both numbers manually tested by
 *   Leuenaar and confirmed not registered/active.
 * - Healing119.id / 119 ext.8 — high confidence, NOT manually tested
 *   live. Verify before shipping to production.
 * - findahelpline.com — maintained verified directory (ThroughLine),
 *   used as international fallback instead of guessing per-country numbers.
 */

const CRISIS_RESOURCES = {
  ID: {
    country_name: 'Indonesia',

    emergency: {
      id:          'emergency-119',
      name_id:     'Layanan Darurat Nasional',
      name_en:     'National Emergency Line',
      description_id: 'Untuk kondisi yang mengancam nyawa secara langsung. Jangan menunggu.',
      description_en: 'For situations of immediate physical danger to life. Do not wait.',
      channels: [
        { type: 'call', label_id: 'Telepon', label_en: 'Call', value: '119' },
      ],
      source:      'https://www.intothelightid.org/tentang-bunuh-diri/hotline-bunuh-diri-di-indonesia/',
      verified_at: '2026-06',
    },

    resources: [
      {
        id:          'healing119',
        name:        'Healing119.id (Kementerian Kesehatan RI)',
        description_id: 'Layanan resmi Kemenkes, gratis, 24 jam, rahasia, kerja sama dengan IPK Indonesia. Diaktifkan ulang 31 Juli 2025.',
        description_en: 'Official Indonesian Ministry of Health service, free, 24/7, confidential, run with IPK Indonesia. Relaunched 31 July 2025.',
        channels: [
          { type: 'call', label_id: 'Telepon', label_en: 'Call', value: '119', note: 'ext. 8' },
        ],
        language:    ['id'],
        source:      'https://kesprimkom.kemkes.go.id/konten/158/151/0/cegah-bunuh-diri-dukung-kesehatan-jiwa-kenali-layanan-healing119-id',
        verified_at: '2026-06',
        confidence:  'high-unverified-live',
      },
    ],

    professional_support: [
      {
        id:          'halodoc',
        name:        'Halodoc',
        description_id: 'Konsultasi berbayar dengan psikolog/psikiater berlisensi, mulai ~Rp55.000/sesi.',
        description_en: 'Paid consultation with licensed psychologists/psychiatrists, from ~Rp55,000/session.',
        channels: [
          { type: 'app', label_id: 'Buka Halodoc', label_en: 'Open Halodoc', value: 'https://www.halodoc.com/kesehatan-mental' },
        ],
        language:    ['id'],
        source:      'https://www.halodoc.com/kesehatan-mental',
        verified_at: '2026-06',
        note:        'Paid, appointment-based — not an emergency line.',
      },
    ],
  },
};

const INTERNATIONAL_FALLBACK = {
  country_name: 'International',
  resources: [
    {
      id:          'findahelpline',
      name:        'Find A Helpline (ThroughLine)',
      description_id: 'Direktori hotline krisis terverifikasi untuk 175+ negara.',
      description_en: 'Verified crisis helpline directory covering 175+ countries.',
      channels: [
        { type: 'web', label_id: 'Cari hotline negaramu', label_en: "Find your country's helpline", value: 'https://findahelpline.com/' },
      ],
      source:      'https://findahelpline.com/',
      verified_at: '2026-06',
    },
    {
      id:          'befrienders',
      name:        'Befrienders Worldwide',
      description_id: 'Jaringan global pusat dukungan krisis, dijalankan badan amal UK.',
      description_en: 'Global network of crisis support centres, run by a UK charity.',
      channels: [
        { type: 'web', label_id: 'Cari pusat dukungan', label_en: 'Find a support centre', value: 'https://befrienders.org/' },
      ],
      source:      'https://befrienders.org/',
      verified_at: '2026-06',
    },
  ],
};

const DEFAULT_COUNTRY = 'ID';

const getCrisisResources = (countryCode) => {
  const code = (countryCode || '').toUpperCase();
  return CRISIS_RESOURCES[code] || INTERNATIONAL_FALLBACK;
};

module.exports = { CRISIS_RESOURCES, INTERNATIONAL_FALLBACK, DEFAULT_COUNTRY, getCrisisResources };