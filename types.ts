export interface QueryAnalysis {
  industry: string;
  function: string;
  key_topics: string[];
  keywords: string[];
  confidence: 'High' | 'Medium' | 'Low';
  confidence_reason: string;
}

export interface SourceLink {
  url: string;
  label: string;
  type: 'LinkedIn' | 'Article' | 'Company Website' | 'Professional Directory' | 'Government Website' | 'Other';
}

export interface Expert {
  id: string;
  name: string;
  title: string;
  company: string;
  location: string;
  category: 'Operator' | 'Advisor' | 'Outsider';
  outsider_subcategory?: 'Government' | 'Large Enterprise' | 'Small Business' | null;
  justification: string;
  relevance_score: number;
  source_url: string;
  source_label: string;
  source_links: SourceLink[];
}

export interface InsufficientExperts {
  category: 'Operator' | 'Advisor' | 'Outsider';
  found: number;
  required: number;
}

export interface ExpertResponse {
  query_analysis: QueryAnalysis;
  experts: Expert[];
  insufficient_categories?: InsufficientExperts[];
}
