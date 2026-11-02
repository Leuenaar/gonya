import { t, type Lang } from '../lib/i18n';
import './PrivacyPolicy.css';

interface Props {
  onBack?: () => void;
  lang?: Lang;
}

interface Section {
  heading: Record<Lang, string>;
  body: Record<Lang, string[]>;
}

const LAST_UPDATED = '2026-07-03';

// Kept local (not migrated into i18n.ts) to minimize transcription risk in
// legal text — same reasoning as SECTIONS below.
const DISCLAIMER_TEXT: Record<Lang, string> = {
  id: 'Dokumen ini disusun sebagai titik awal yang mengikuti prinsip UU PDP dan GDPR, dan bukan merupakan nasihat hukum. Leuenaar menyarankan tinjauan oleh profesional hukum sebelum kebijakan ini digunakan untuk menerima pengguna secara luas.',
  en: 'This document is drafted as a starting point following UU PDP and GDPR principles, and does not constitute legal advice. Leuenaar recommends review by a legal professional before this policy is relied on to accept users at scale.',
};

const SECTIONS: Section[] = [
  {
    heading: { id: 'Pendahuluan', en: 'Introduction' },
    body: {
      id: [
        'Kebijakan Privasi ini menjelaskan bagaimana Leuenaar ("kami") mengumpulkan, menggunakan, menyimpan, dan melindungi data pribadi kamu saat menggunakan Gonya, platform personal berbasis AI ("Layanan").',
        'Kami berkomitmen melindungi privasi kamu dan mematuhi hukum perlindungan data yang berlaku, termasuk Undang-Undang Pelindungan Data Pribadi Republik Indonesia (UU No. 27 Tahun 2022, "UU PDP"). Untuk pengguna di luar Indonesia, kami juga menerapkan prinsip yang selaras dengan General Data Protection Regulation (GDPR) Uni Eropa, termasuk hak akses, koreksi, dan penghapusan data.',
        'Dengan membuat akun atau menggunakan Gonya, kamu menyetujui praktik yang dijelaskan dalam kebijakan ini.',
      ],
      en: [
        'This Privacy Policy explains how Leuenaar ("we," "us," "our") collects, uses, stores, and protects your personal data when you use Gonya, an AI-powered personal platform (the "Service").',
        'We are committed to protecting your privacy and complying with applicable data protection laws, including Indonesia\'s Personal Data Protection Law (Law No. 27 of 2022, "UU PDP"). For users outside Indonesia, we also follow principles consistent with the EU General Data Protection Regulation (GDPR), including rights to access, correct, and delete your data.',
        'By creating an account or using Gonya, you agree to the practices described in this policy.',
      ],
    },
  },
  {
    heading: { id: 'Data yang Kami Kumpulkan', en: 'What We Collect' },
    body: {
      id: [
        'Akun — email, nama tampilan, kata sandi (di-hash, tidak pernah disimpan dalam bentuk asli), preferensi bahasa, dan informasi yang kamu pilih bagikan untuk personalisasi agen (misalnya gender, dipakai semata untuk menentukan agen mana — Aksel/Vera atau Thea/Theo — yang memimpin percakapanmu).',
        'Percakapan — pesan yang kamu kirim ke Aksel dan Vera, beserta balasannya, termasuk lampiran file yang kamu unggah.',
        'Memori — Gonya secara otomatis mengekstrak "memori" dari percakapanmu (misalnya preferensi, konteks berulang) untuk personalisasi. Setiap memori butuh persetujuanmu (approve/reject) sebelum benar-benar dipakai, dan bisa kamu hapus kapan saja.',
        'Kalender dan preferensi berita — acara yang kamu buat, kategori topik yang kamu pilih, dan sumber RSS custom yang kamu tambahkan.',
        'Masukan dan dukungan — isi formulir feedback, dan transkrip percakapan Live Chat dengan Thea/Theo kalau kamu memakai fitur itu.',
        'Karena kamu bisa membicarakan apa saja dengan Aksel dan Vera, percakapanmu bisa saja secara tidak sengaja menyinggung kategori data yang lebih sensitif (misalnya kondisi kesehatan). UU PDP memberi perlindungan lebih ketat untuk kategori data ini — kami memperlakukannya dengan kehati-hatian yang sama seperti data pribadi lain, dan tidak menganalisisnya untuk tujuan di luar percakapan itu sendiri.',
        'Data teknis — log penggunaan (untuk pemantauan biaya dan performa internal), cookie, dan data tersimpan lokal di browser (localStorage) untuk preferensi tampilan seperti widget yang aktif.',
      ],
      en: [
        'Account — email, display name, password (hashed, never stored in plain form), language preference, and information you choose to share for agent personalization (e.g. gender, used solely to determine which agent — Aksel/Vera or Thea/Theo — leads your conversation).',
        'Conversations — messages you send to Aksel and Vera, and their replies, including any files you attach.',
        'Memory — Gonya automatically extracts "memories" from your conversations (e.g. preferences, recurring context) for personalization. Every memory requires your approval (approve/reject) before it\'s actually used, and you can delete it at any time.',
        'Calendar and news preferences — events you create, topic categories you select, and custom RSS sources you add.',
        'Feedback and support — content of feedback forms, and Live Chat transcripts with Thea/Theo if you use that feature.',
        'Because you can talk to Aksel and Vera about anything, your conversations may incidentally touch on more sensitive data categories (e.g. health conditions). UU PDP affords stricter protection to these categories — we handle them with the same care as any other personal data, and don\'t analyze them for purposes beyond the conversation itself.',
        'Technical data — usage logs (for internal cost and performance monitoring), cookies, and browser local storage for display preferences like which widgets are active.',
      ],
    },
  },
  {
    heading: { id: 'Notifikasi Pelanggaran Data', en: 'Data Breach Notification' },
    body: {
      id: [
        'Kalau terjadi pelanggaran keamanan yang berdampak pada data pribadimu, kami akan memberi tahu kamu dan otoritas yang berwenang secara tertulis dalam waktu 3×24 jam (72 jam) sejak kami menyadari kejadian tersebut, sesuai Pasal 46 UU PDP dan standar yang sejalan dengan GDPR. Notifikasi akan mencakup sifat pelanggaran, data yang terdampak, dan langkah mitigasi yang kami ambil.',
      ],
      en: [
        'If a security breach affects your personal data, we will notify you and the relevant authority in writing within 3×24 hours (72 hours) of becoming aware of the incident, consistent with Article 46 of UU PDP and GDPR-aligned standards. The notification will cover the nature of the breach, the data affected, and the mitigation steps we\'ve taken.',
      ],
    },
  },
  {
    heading: { id: 'Bagaimana Kami Menggunakan Data Kamu', en: 'How We Use Your Data' },
    body: {
      id: [
        'Menjalankan Layanan inti — memproses percakapanmu dengan Aksel dan Vera, dan menghasilkan balasan yang relevan.',
        'Personalisasi — memakai memori yang sudah kamu setujui dan preferensi kategori untuk menyesuaikan berita, saran, dan gaya interaksi agen.',
        'Keamanan — mendeteksi indikasi distress dalam percakapan untuk menawarkan sumber daya bantuan yang relevan (lihat bagian Keamanan di bawah).',
        'Dukungan pelanggan — merespons pertanyaan atau masukan yang kamu kirim lewat Pusat Bantuan.',
        'Peningkatan Layanan — analisis penggunaan agregat secara internal untuk memperbaiki performa dan keandalan sistem.',
        'Kami TIDAK menjual data pribadimu ke pihak ketiga untuk kepentingan iklan atau tujuan komersial lain di luar operasional Layanan.',
      ],
      en: [
        'Running the core Service — processing your conversations with Aksel and Vera, and generating relevant replies.',
        'Personalization — using memories you\'ve approved and category preferences to tailor news, suggestions, and agent interaction style.',
        'Safety — detecting signs of distress in conversations to offer relevant support resources (see Safety section below).',
        'Customer support — responding to questions or feedback you send through Contact Support.',
        'Service improvement — internal aggregate usage analysis to improve system performance and reliability.',
        'We do NOT sell your personal data to third parties for advertising or other commercial purposes outside operating the Service.',
      ],
    },
  },
  {
    heading: { id: 'Dasar Hukum Pemrosesan', en: 'Legal Basis for Processing' },
    body: {
      id: [
        'Kami memproses data pribadimu berdasarkan: (a) persetujuanmu saat membuat akun dan menggunakan fitur tertentu (misalnya menyetujui sebuah memori); (b) kebutuhan untuk menjalankan kontrak layanan denganmu (menyediakan fungsi inti Gonya); dan (c) kepentingan sah kami untuk menjaga keamanan dan meningkatkan Layanan, selama tidak bertentangan dengan hak-hak dasarmu.',
        'Kamu bisa menarik persetujuan kapan saja untuk pemrosesan yang berbasis persetujuan, tanpa memengaruhi keabsahan pemrosesan yang sudah terjadi sebelumnya.',
      ],
      en: [
        'We process your personal data based on: (a) your consent when creating an account and using certain features (e.g. approving a memory); (b) the necessity of performing our service contract with you (providing Gonya\'s core functionality); and (c) our legitimate interest in maintaining security and improving the Service, provided this doesn\'t override your fundamental rights.',
        'You may withdraw consent at any time for consent-based processing, without affecting the lawfulness of processing already carried out before withdrawal.',
      ],
    },
  },
  {
    heading: { id: 'Pihak Ketiga yang Kami Pakai', en: 'Third-Party Services We Use' },
    body: {
      id: [
        'Gonya bergantung pada sejumlah penyedia layanan pihak ketiga untuk beroperasi. Masing-masing hanya menerima data yang diperlukan untuk fungsinya:',
        'Supabase (autentikasi dan database), Anthropic (model Claude yang menggerakkan Vera dan TheOnes), Groq (model Llama yang menggerakkan Aksel, Thea, dan Theo), Voyage AI (pencarian semantik/embedding), Cloudinary (penyimpanan file yang kamu unggah), Upstash (caching sementara), Resend (pengiriman email seperti verifikasi akun dan notifikasi tiket), dan The Guardian API (konten berita berbahasa Inggris).',
        'Deepgram (layanan suara) terdaftar sebagai penyedia cadangan tapi BELUM AKTIF digunakan di Layanan saat ini.',
        'Setiap penyedia ini punya kebijakan privasinya masing-masing dan bertindak sebagai prosesor data atas nama kami, bukan pemilik datamu.',
      ],
      en: [
        'Gonya relies on a number of third-party service providers to operate. Each receives only the data necessary for its function:',
        'Supabase (authentication and database), Anthropic (the Claude models powering Vera and TheOnes), Groq (the Llama models powering Aksel, Thea, and Theo), Voyage AI (semantic search/embeddings), Cloudinary (storage for files you upload), Upstash (temporary caching), Resend (sending emails such as account verification and ticket notifications), and The Guardian API (English-language news content).',
        'Deepgram (voice service) is registered as a backup provider but is NOT currently active in the Service.',
        'Each of these providers has its own privacy policy and acts as a data processor on our behalf, not an owner of your data.',
      ],
    },
  },
  {
    heading: { id: 'Transfer Data Internasional', en: 'International Data Transfers' },
    body: {
      id: [
        'Beberapa penyedia layanan pihak ketiga di atas memproses data di server yang berlokasi di luar Indonesia (termasuk Amerika Serikat dan Uni Eropa). Kami memastikan penyedia tersebut menerapkan perlindungan yang memadai sesuai standar industri sebelum data kamu diproses di sana.',
      ],
      en: [
        'Some of the third-party providers above process data on servers located outside Indonesia (including the United States and the European Union). We ensure these providers apply adequate industry-standard safeguards before your data is processed there.',
      ],
    },
  },
  {
    heading: { id: 'Berapa Lama Data Disimpan', en: 'Data Retention' },
    body: {
      id: [
        'Kami menyimpan data pribadimu selama akunmu aktif. Kalau kamu menghapus akun, kami akan menghapus atau menganonimkan data pribadimu dalam waktu yang wajar, kecuali ada kewajiban hukum yang mengharuskan kami menyimpannya lebih lama (misalnya catatan transaksi untuk kepentingan audit).',
        'Log teknis dan data penggunaan agregat yang sudah tidak bisa dikaitkan langsung ke identitasmu bisa disimpan lebih lama untuk kepentingan analisis internal.',
      ],
      en: [
        'We retain your personal data for as long as your account is active. If you delete your account, we will delete or anonymize your personal data within a reasonable timeframe, unless a legal obligation requires us to retain it longer (e.g. transaction records for audit purposes).',
        'Technical logs and aggregate usage data that can no longer be directly linked to your identity may be retained longer for internal analysis purposes.',
      ],
    },
  },
  {
    heading: { id: 'Hak Kamu', en: 'Your Rights' },
    body: {
      id: [
        'Sesuai UU PDP dan prinsip GDPR, kamu berhak untuk: mengakses data pribadi yang kami simpan tentangmu; meminta koreksi data yang tidak akurat; meminta penghapusan data pribadimu ("hak untuk dilupakan"); menarik persetujuan yang sudah kamu berikan; meminta salinan datamu dalam format yang bisa dipindahkan (portabilitas data); mengajukan keberatan atas pemrosesan tertentu; dan mengajukan pengaduan ke otoritas pelindungan data yang berwenang.',
        'Secara khusus untuk sistem memori: kamu berhak menolak sebuah memori sebelum dipakai (lewat approve/reject), dan menghapus memori yang sudah disetujui kapan saja. Ini bukan keputusan otomatis penuh — setiap memori baru selalu menunggu tinjauanmu dulu sebelum memengaruhi cara agen merespons.',
        'Untuk menggunakan hak-hak ini, hubungi kami lewat kontak di bagian bawah kebijakan ini. Kami akan merespons permintaanmu dalam waktu yang wajar sesuai ketentuan hukum yang berlaku.',
      ],
      en: [
        'Consistent with UU PDP and GDPR principles, you have the right to: access the personal data we hold about you; request correction of inaccurate data; request deletion of your personal data ("right to be forgotten"); withdraw consent you\'ve previously given; request a copy of your data in a portable format (data portability); object to certain processing; and lodge a complaint with the relevant data protection authority.',
        'Specifically for the memory system: you can reject a memory before it\'s used (via approve/reject), and delete an approved memory at any time. This isn\'t a fully automated decision — every new memory always waits for your review before it affects how the agents respond.',
        'To exercise these rights, contact us using the details at the bottom of this policy. We will respond to your request within a reasonable timeframe as required by applicable law.',
      ],
    },
  },
  {
    heading: { id: 'Keamanan (Fitur Dukungan Distress)', en: 'Safety (Distress Support Feature)' },
    body: {
      id: [
        'Gonya memiliki sistem yang mendeteksi indikasi kata kunci distress dalam percakapan untuk menawarkan sumber daya bantuan yang relevan (misalnya nomor layanan krisis). Fitur ini dirancang untuk membantu, bukan untuk memantau atau menilai kamu, dan tidak membuat catatan tambahan di luar percakapan itu sendiri.',
        'Gonya bukan pengganti layanan kesehatan mental profesional. Kalau kamu sedang dalam krisis, segera hubungi layanan darurat setempat atau tenaga profesional yang kamu percaya.',
      ],
      en: [
        'Gonya has a system that detects indications of distress-related keywords in conversation to offer relevant support resources (e.g. crisis line numbers). This feature is designed to help, not to monitor or evaluate you, and does not create additional records beyond the conversation itself.',
        'Gonya is not a substitute for professional mental health care. If you are in crisis, please contact your local emergency services or a professional you trust right away.',
      ],
    },
  },
  {
    heading: { id: 'Privasi Anak', en: "Children's Privacy" },
    body: {
      id: [
        'Gonya tidak ditujukan untuk anak di bawah usia 16 tahun, dan kami tidak dengan sengaja mengumpulkan data pribadi dari anak di bawah usia tersebut. Kalau kamu mengetahui ada anak di bawah 16 tahun yang menggunakan Gonya, hubungi kami agar kami bisa menghapus data yang bersangkutan.',
      ],
      en: [
        'Gonya is not intended for children under 16 years old, and we do not knowingly collect personal data from children under that age. If you become aware that a child under 16 is using Gonya, please contact us so we can remove the relevant data.',
      ],
    },
  },
  {
    heading: { id: 'Cookie dan Local Storage', en: 'Cookies and Local Storage' },
    body: {
      id: [
        'Kami memakai cookie sesi untuk menjaga status login kamu, dan localStorage browser untuk menyimpan preferensi tampilan (misalnya widget mana yang aktif). Kami tidak memakai cookie untuk pelacakan iklan pihak ketiga.',
      ],
      en: [
        'We use session cookies to keep you signed in, and browser localStorage to remember display preferences (e.g. which widgets are active). We do not use cookies for third-party advertising tracking.',
      ],
    },
  },
  {
    heading: { id: 'Keamanan Data', en: 'Data Security' },
    body: {
      id: [
        'Kami menerapkan langkah teknis dan organisasional yang wajar untuk melindungi data pribadimu, termasuk enkripsi kata sandi, koneksi terenkripsi (HTTPS/TLS), dan pembatasan akses internal. Meski begitu, tidak ada sistem yang 100% aman, dan kami tidak bisa menjamin keamanan mutlak.',
      ],
      en: [
        'We implement reasonable technical and organizational measures to protect your personal data, including password encryption, encrypted connections (HTTPS/TLS), and internal access restrictions. That said, no system is 100% secure, and we cannot guarantee absolute security.',
      ],
    },
  },
  {
    heading: { id: 'Perubahan Kebijakan Ini', en: 'Changes to This Policy' },
    body: {
      id: [
        'Kami bisa memperbarui kebijakan ini dari waktu ke waktu. Perubahan signifikan akan kami beri tahu lewat email atau notifikasi dalam aplikasi. Tanggal "Terakhir diperbarui" di atas menunjukkan revisi paling baru.',
      ],
      en: [
        'We may update this policy from time to time. Significant changes will be communicated via email or an in-app notification. The "Last updated" date above reflects the most recent revision.',
      ],
    },
  },
  {
    heading: { id: 'Hubungi Kami', en: 'Contact Us' },
    body: {
      id: [
        'Untuk pertanyaan seputar privasi, permintaan akses/koreksi/penghapusan data, atau keluhan lainnya, hubungi kami di leuenaars@gmail.com.',
      ],
      en: [
        'For privacy questions, data access/correction/deletion requests, or other complaints, contact us at leuenaars@gmail.com.',
      ],
    },
  },
];

export default function PrivacyPolicy({ onBack, lang }: Props) {
  const activeLang: Lang = lang === 'id' ? 'id' : 'en';

  return (
    <div className="pp-root">
      <div className="pp-scanline" aria-hidden="true" />

      <header className="pp-header">
        <div className="pp-header-top">
          {onBack && (
            <button className="pp-back-btn" onClick={onBack}>
              {t('ppBack', activeLang)}
            </button>
          )}
        </div>
        <span className="pp-kicker">GONYA</span>
        <h1 className="pp-title">{t('ppTitle', activeLang)}</h1>
        <p className="pp-updated">
          {t('ppLastUpdated', activeLang)}: {LAST_UPDATED}
        </p>
      </header>

      <main className="pp-body">
        {SECTIONS.map((s, i) => (
          <section className="pp-section" key={i}>
            <h2 className="pp-section-title">
              <span className="pp-section-num">{String(i + 1).padStart(2, '0')}</span>
              {s.heading[activeLang]}
            </h2>
            {s.body[activeLang].map((p, j) => (
              <p className="pp-section-p" key={j}>{p}</p>
            ))}
          </section>
        ))}

        <div className="pp-disclaimer">
          <span className="pp-disclaimer-label">{t('ppNoteLabel', activeLang)}</span>
          <p>{DISCLAIMER_TEXT[activeLang]}</p>
        </div>
      </main>

      <footer className="pp-footer">
        <span>GONYA</span>
        <span className="pp-footer-tagline">Thought, undivided.</span>
      </footer>
    </div>
  );
}
