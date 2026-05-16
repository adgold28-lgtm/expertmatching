import NavBar from '../../components/NavBar';
import RequestAccessForm from './RequestAccessForm';

export default function RequestAccessPage() {
  return (
    <div className="min-h-screen flex flex-col font-body" style={{ background: '#F7F9FC' }}>
      <NavBar />
      <RequestAccessForm />
    </div>
  );
}
