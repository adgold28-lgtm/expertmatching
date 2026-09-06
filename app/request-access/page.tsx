import type { Metadata } from 'next';
import NavBar from '../../components/NavBar';
import MarketingFooter from '../../components/MarketingFooter';
import RequestAccessForm from './RequestAccessForm';

export const metadata: Metadata = {
  title: 'Request Access — ExpertMatch',
  description:
    'ExpertMatch is invite only. Tell us about your team and what you are researching, and we will follow up within one business day.',
};

export default function RequestAccessPage() {
  return (
    <div className="min-h-screen flex flex-col font-body" style={{ background: '#F7F9FC' }}>
      <NavBar />
      <RequestAccessForm />
      <MarketingFooter />
    </div>
  );
}
