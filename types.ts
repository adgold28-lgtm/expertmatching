export interface QueryAnalysis {
  industry: string;
  function: string;
  key_topics: string[];
  keywords: string[];
  confidence: 'High' | 'Medium' | 'Low';
  confidence_reason: string;
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
