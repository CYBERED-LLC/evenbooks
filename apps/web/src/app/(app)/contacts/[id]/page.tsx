import { ContactDetailView } from './view';

export const metadata = { title: 'Contact' };

export default async function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContactDetailView id={id} />;
}
