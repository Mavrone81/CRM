'use client';

// Public e-sign portal (per-lead HMAC token, like /book). The lead reads the
// agreement, fills the required fields, draws a signature, and submits — the CRM
// validates deterministically and advances to `signed`. Mobile-first: leads open
// this from a WhatsApp link on their phones.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';

type Data = { name: string; doc: { name: string } | null; fields: string[]; signed: boolean };

// Minimal draw-to-sign canvas (pointer events — works with finger, stylus, mouse).
function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    // Match the backing store to the displayed size for crisp strokes.
    const scale = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = rect.width * scale;
    c.height = rect.height * scale;
    const ctx = c.getContext('2d')!;
    ctx.scale(scale, scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  const pos = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    canvasRef.current!.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = canvasRef.current!.getContext('2d')!;
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current!.getContext('2d')!;
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    dirty.current = true;
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (dirty.current) onChange(canvasRef.current!.toDataURL('image/png'));
  };
  const clear = () => {
    const c = canvasRef.current!;
    const ctx = c.getContext('2d')!;
    const rect = c.getBoundingClientRect();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rect.width, rect.height);
    dirty.current = false;
    onChange(null);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <canvas
        ref={canvasRef}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        className="w-full h-36 bg-white rounded-lg border border-gray-600 touch-none cursor-crosshair"
        aria-label="Signature area — draw your signature here"
      />
      <div className="flex justify-between items-center">
        <span className="text-xs text-gray-500">Sign above with your finger or mouse</span>
        <button type="button" onClick={clear} className="text-xs text-gray-400 hover:text-gray-200 underline">Clear</button>
      </div>
    </div>
  );
}

export default function SignPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token as string;
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<Record<string, string>>({});
  const [signature, setSignature] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/proxy/sign/${token}`);
      const d = await r.json();
      if (r.ok) setData(d);
      else setError(d.error || 'Could not load the agreement.');
    } catch { setError('Network error — please try again.'); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const canSubmit = !!data && data.fields.every((f) => (values[f] || '').trim()) && !!signature && agreed && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setError(''); setMissing([]);
    try {
      const r = await fetch(`/api/proxy/sign/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: values, signature }),
      });
      const d = await r.json();
      if (r.ok) setDone(true);
      else if (d.missing) { setMissing(d.missing); setError('Please complete the highlighted fields.'); }
      else setError(d.error || 'Could not submit — please try again.');
    } catch { setError('Network error — please try again.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex items-start sm:items-center justify-center p-4">
      <div className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-2xl p-5 sm:p-6 mt-6 sm:mt-0 mb-8">
        <div className="text-center mb-5">
          <div className="text-sm text-green-400 font-medium">Pet Afterlife SG</div>
          <h1 className="text-lg sm:text-xl font-semibold mt-1">Associate Agreement</h1>
        </div>

        {loading && <p className="text-center text-gray-500 py-8">Loading…</p>}
        {error && !data && <p className="text-center text-red-400 py-8">{error}</p>}

        {data && (data.signed || done) ? (
          <div className="text-center py-6 flex flex-col gap-2">
            <div className="text-4xl">✅</div>
            <p className="text-base font-medium">{done ? 'Agreement signed!' : 'Already signed'}</p>
            <p className="text-sm text-gray-400 mt-1">
              Thank you{data.name ? `, ${data.name}` : ''} — we&apos;ve recorded your signed agreement and will be in touch with the next steps. You can close this page.
            </p>
          </div>
        ) : data ? (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <p className="text-sm text-gray-300">
              Hi {data.name} — please review the agreement, fill in your details, and sign below.
            </p>

            {data.doc && (
              <a href={`/api/proxy/sign/${token}/doc`} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-cyan-200">
                📄 <span className="underline">Read the agreement — {data.doc.name}</span>
              </a>
            )}

            {data.fields.map((f, i) => (
              <div key={f} className="flex flex-col gap-1.5">
                <label htmlFor={`sf-${i}`} className="text-xs font-medium text-gray-400">{f}</label>
                <input
                  id={`sf-${i}`}
                  value={values[f] || ''}
                  onChange={(e) => setValues((p) => ({ ...p, [f]: e.target.value }))}
                  className={`min-h-[44px] bg-gray-800 border rounded-lg px-3 text-sm text-gray-200 focus:outline-none focus:border-green-600 ${missing.includes(f) ? 'border-red-600' : 'border-gray-700'}`}
                />
              </div>
            ))}

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-400">Your signature</label>
              <SignaturePad onChange={setSignature} />
            </div>

            <label className="flex items-start gap-2.5 text-sm text-gray-300 cursor-pointer">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 w-4 h-4 accent-green-600" />
              <span>I have read the agreement and agree to sign it electronically.</span>
            </label>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <button type="submit" disabled={!canSubmit}
              className="min-h-[48px] bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg text-sm transition-colors">
              {busy ? 'Submitting…' : 'Sign agreement'}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
