import {
  IconBuildingBank,
  IconCoin,
  IconId,
  IconWorld,
  IconTrendingUp,
  IconCurrencyDollar,
} from "@tabler/icons-react";
import rawDemoProtocols from "@/data/demo-protocols.json";

export interface Requirement {
  label: string;
  type: string;
  minThreshold?: number;
}

export interface Protocol {
  id: string;
  name: string;
  tagline: string;
  description: string;
  stat: { label: string; value: string; sub: string };
  requirements: Requirement[];
  verifyUrl: string;
  actionLabel: string;
  inputLabel: string;
  inputDefault: string;
  /** Present on every demo protocol; absent (or false) on real integrations. */
  isDemo?: boolean;
  icon: React.ReactNode;
}

/** Maps the serialisable icon key stored in demo-protocols.json to a React node. */
function resolveIcon(key: string): React.ReactNode {
  switch (key) {
    case "bank":     return <IconBuildingBank size={18} stroke={1.6} />;
    case "id":       return <IconId size={18} stroke={1.6} />;
    case "coin":     return <IconCoin size={18} stroke={1.6} />;
    case "world":    return <IconWorld size={18} stroke={1.6} />;
    case "trending": return <IconTrendingUp size={18} stroke={1.6} />;
    case "dollar":   return <IconCurrencyDollar size={18} stroke={1.6} />;
    default:         return null;
  }
}

/** All demo protocols, hydrated with their React icon nodes. */
export const PROTOCOLS: Protocol[] = (
  rawDemoProtocols as Array<Omit<Protocol, "icon"> & { iconKey: string }>
).map(({ iconKey, ...rest }) => ({
  ...rest,
  icon: resolveIcon(iconKey),
}));

export function getProtocol(id: string): Protocol | undefined {
  return PROTOCOLS.find((p) => p.id === id);
}
