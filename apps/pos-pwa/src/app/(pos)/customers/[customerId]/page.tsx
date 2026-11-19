import { CustomerAccount } from '@/components/pos/customer-screens';

export default async function CustomerAccountPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await params;
  return <CustomerAccount customerId={customerId} />;
}
