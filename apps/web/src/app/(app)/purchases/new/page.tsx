import { NewPurchaseView } from './view';

export const metadata = { title: 'Record expense' };

export default async function NewPurchasePage({ searchParams }: { searchParams: Promise<{ copyFrom?: string }> }) {
  const { copyFrom } = await searchParams;
  return <NewPurchaseView copyFrom={copyFrom} />;
}
