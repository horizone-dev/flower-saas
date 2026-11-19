import { SaleDetail } from '@/components/pos/sales-screens';

export default async function SaleDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  return <SaleDetail orderId={orderId} />;
}
