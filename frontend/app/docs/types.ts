export interface TocItem {
  id: string;
  label: string;
  level: number;
  content: string;
}

export interface DocCategory {
  id: string;
  title: string;
  icon?: string;
  items: TocItem[];
}
