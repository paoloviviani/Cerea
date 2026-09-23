import type { EnrollmentCheck } from "$lib/codeApi";

/**
 * Per-device enrollment liveness, as the cheap models probe last found it.
 * Module state, not component state: the device pill (`CodeNavTree`) and the
 * composer guard (`AgentView`/`AgentComposer`) are siblings under different
 * parents, and both need the same word the probe (`CodePanel`, on agent open
 * and on device switch) last wrote. Devices this session never probed are
 * simply absent — the pill's default rendering (the device's own `status`)
 * carries no claim either way.
 */
export const codeEnrollment = $state<Record<string, EnrollmentCheck>>({});
