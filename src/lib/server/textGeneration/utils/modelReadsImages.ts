/**
 * Whether a model is sent images: the person's per-model override first (an
 * explicit `false` withdraws what the model advertises, `true` grants what it
 * does not), else what the model advertises. The same rule generation applies
 * (`isMultimodal: forceMultimodal ?? model.multimodal`), kept in one place so
 * the upload that decides whether to render a scan's pages and the turn that
 * sends them cannot disagree.
 */
export function modelReadsImages(model: { multimodal?: boolean }, override?: boolean): boolean {
	return override ?? model.multimodal === true;
}
