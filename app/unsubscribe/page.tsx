// Static confirmation page for unsubscribe flow.
// Reached via redirect from GET /api/unsubscribe after token processing.

interface Props {
  searchParams: { status?: string };
}

export default function UnsubscribePage({ searchParams }: Props) {
  const status = searchParams.status;

  let heading: string;
  let body: string;
  let isError = false;

  if (status === 'success') {
    heading = 'Unsubscribed';
    body    = 'You have been removed from our outreach list. We will not contact you again.';
  } else if (status === 'expired') {
    heading = 'Link expired';
    body    = 'This unsubscribe link has expired. Reply directly to any email you received to request removal.';
    isError = true;
  } else {
    heading = 'Invalid link';
    body    = 'This unsubscribe link is not valid. Reply directly to any email you received to request removal.';
    isError = true;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-sm text-center">
        <h1 className={`text-xl font-semibold mb-3 ${isError ? 'text-red-700' : 'text-gray-900'}`}>
          {heading}
        </h1>
        <p className="text-gray-500 text-sm leading-relaxed">{body}</p>
      </div>
    </main>
  );
}
