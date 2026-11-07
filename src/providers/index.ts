import { github } from './github.js';
import { gitlab } from './gitlab.js';

export const providers = { github, gitlab };

export function getProvider(name = 'github') {
  const provider = providers[name];
  if (!provider) {
    throw new Error(
      `Unknown provider "${name}". Registered: ${Object.keys(providers).join(', ')}. ` +
      'Add one in src/providers/index.ts (see references/providers.md).'
    );
  }
  return provider;
}
