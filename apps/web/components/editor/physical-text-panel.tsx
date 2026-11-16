import type { TextOverlay } from "@reelwalk/core";
import { physicalTextProblem, physicalTextSchema } from "@reelwalk/core";

type Draft = Pick<TextOverlay,"text"|"physical3d"|"size">;
export function PhysicalTextPanel({draft,onChange}:{draft:Draft;onChange:(physical3d:TextOverlay["physical3d"])=>void}) {
  const config=draft.physical3d,problem=physicalTextProblem(draft.text,draft.size);
  return <section aria-label="Physical 3D title">
    <label className="field small"><input type="checkbox" checked={!!config} disabled={!config && !!problem} onChange={e=>onChange(e.target.checked ? physicalTextSchema.parse({}) : undefined)}/> Solid 3D letters</label>
    {problem ? <p className="small" role="status">{problem}</p> : null}
    {config ? <>
      <p className="muted small">Instrument Sans solid letters, authored placement and bounded wall shadow. Place the title on a clear surface. No automatic reconstruction, tracking or object masking. The complete title stays inside Instagram safe margins.</p>
      <label className="field">Letter depth<input type="range" min="0.06" max="0.3" step="0.02" value={config.depth} onChange={e=>onChange({...config,depth:Number(e.target.value)})}/></label>
      <label className="field">Wall angle<input type="range" min="-20" max="20" step="1" value={config.tilt} onChange={e=>onChange({...config,tilt:Number(e.target.value)})}/></label>
      <label className="field">Scene light<select className="text-input" value={config.light} onChange={e=>onChange({...config,light:e.target.value as typeof config.light})}><option value="left">From left</option><option value="right">From right</option><option value="above">From above</option></select></label>
      <label className="field">Contact shadow<input type="range" min="0" max="0.6" step="0.05" value={config.shadow} onChange={e=>onChange({...config,shadow:Number(e.target.value)})}/></label>
      <label className="field small"><input type="checkbox" checked={config.motion} onChange={e=>onChange({...config,motion:e.target.checked})}/> Gentle 3D movement, then hold until the cut</label>
    </> : null}
  </section>;
}
