import { paginateScan } from "@aws-sdk/client-dynamodb";

export async function scanAllItems(client, input, paginate = paginateScan) {
  const items = [];
  for await (const page of paginate({ client }, input)) {
    items.push(...(page.Items || []));
  }
  return items;
}
