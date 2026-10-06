import type { Register } from 'claude-code'

import { registerGlance } from './glance'

export const register: Register = on => {
  registerGlance(on)
}
