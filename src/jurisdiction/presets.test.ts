import { JurisdictionPresetResolver, JURISDICTION_PRESETS } from './presets';

describe('JurisdictionPresetResolver (#391)', () => {
  it('resolves named presets to correct ISO numeric codes', () => {
    const usCodes = JurisdictionPresetResolver.resolve('US-ONLY');
    expect(usCodes).toEqual(['840']);

    const euCodes = JurisdictionPresetResolver.resolve('EU');
    expect(euCodes.length).toBeGreaterThan(20);
  });

  it('allows custom arrays of ISO numeric codes', () => {
    const customCodes = ['840', '124', '826'];
    expect(JurisdictionPresetResolver.resolve(customCodes)).toEqual(customCodes);
  });

  it('throws informative error on unknown preset name', () => {
    expect(() => JurisdictionPresetResolver.resolve('INVALID' as any)).toThrow(/Unknown jurisdiction preset/);
  });

  it('returns empty array when input is undefined', () => {
    expect(JurisdictionPresetResolver.resolve(undefined)).toEqual([]);
  });
});
