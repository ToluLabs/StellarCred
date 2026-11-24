export type JurisdictionPresetName = 'EU' | 'US-ONLY' | 'NON-SANCTIONED';

export const JURISDICTION_PRESETS: Record<JurisdictionPresetName, string[]> = {
  'US-ONLY': ['840'], // United States
  'EU': [
    '040', '056', '100', '191', '196', '203', '208', '233', '246', '250',
    '276', '300', '348', '372', '380', '428', '440', '442', '470', '528',
    '616', '620', '703', '705', '724', '752'
  ],
  'NON-SANCTIONED': [
    '840', '250', '276', '826', '392', '124', '372', '756', '752', '380', '036', '554'
  ]
};

export class JurisdictionPresetResolver {
  public static resolve(input?: JurisdictionPresetName | string[]): string[] {
    if (!input) {
      return [];
    }
    if (Array.isArray(input)) {
      return input;
    }
    const upper = input.toUpperCase() as JurisdictionPresetName;
    if (JURISDICTION_PRESETS[upper]) {
      return JURISDICTION_PRESETS[upper];
    }
    throw new Error(`Unknown jurisdiction preset: "${input}". Use a valid preset (${Object.keys(JURISDICTION_PRESETS).join(', ')}) or custom array.`);
  }
}
