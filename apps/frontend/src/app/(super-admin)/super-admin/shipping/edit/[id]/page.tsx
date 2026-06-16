import ShippingMethodForm from "../../ShippingMethodForm";

export default async function EditShippingMethodPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ShippingMethodForm mode="edit" id={id} />;
}
