import { describe, expect, it } from 'vitest';
import { isIntakeEnvironmentAllowed } from '@/modules/integration/intake-config';

describe('integration status follows the database environment gate', () => {
  it.each(['unset', 'staging', 'unknown'])('reports %s as disabled for every portal', (environment) => {
    expect(isIntakeEnvironmentAllowed(environment, 'synthetic.bitrix24.test')).toBe(false);
    expect(isIntakeEnvironmentAllowed(environment, 'example.bitrix24.com')).toBe(false);
  });
  it('only allows synthetic portals in test mode', () => {
    expect(isIntakeEnvironmentAllowed('test', 'synthetic.bitrix24.test')).toBe(true);
    expect(isIntakeEnvironmentAllowed('test', 'example.bitrix24.com')).toBe(false);
  });
  it('only allows real-format portals in operational mode', () => {
    expect(isIntakeEnvironmentAllowed('operational', 'example.bitrix24.com')).toBe(true);
    expect(isIntakeEnvironmentAllowed('operational', 'synthetic.bitrix24.test')).toBe(false);
  });
  it('never treats missing portal configuration as ready', () => {
    expect(isIntakeEnvironmentAllowed('operational', null)).toBe(false);
    expect(isIntakeEnvironmentAllowed('test', null)).toBe(false);
  });
});
