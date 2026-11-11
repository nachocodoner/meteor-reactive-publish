export const profiles = {
  smoke: {
    clients: 2,
    parents: 4,
    children: 2,
    operations: 12,
    warmup: 2,
    timeout: 15000,
    observation: 50,
  },
  standard: {
    clients: 25,
    parents: 100,
    children: 10,
    operations: 100,
    warmup: 10,
    timeout: 30000,
    observation: 100,
  },
  stress: {
    clients: 100,
    parents: 100,
    children: 10,
    operations: 500,
    warmup: 20,
    timeout: 60000,
    observation: 100,
  },
};

export function resolveProfile(name, overrides = {}) {
  if (!profiles[name]) throw new Error(`Unknown profile: ${name}`);
  const profile = { ...profiles[name] };
  for (const key of Object.keys(profile)) {
    if (overrides[key] !== undefined) profile[key] = Number(overrides[key]);
    if (
      !Number.isSafeInteger(profile[key]) ||
      profile[key] < (key === 'warmup' ? 0 : 1)
    ) {
      throw new Error(
        `${key} must be a ${key === 'warmup' ? 'nonnegative' : 'positive'} integer`
      );
    }
  }
  if (profile.parents < 2) throw new Error('parents must be at least 2');
  return profile;
}
