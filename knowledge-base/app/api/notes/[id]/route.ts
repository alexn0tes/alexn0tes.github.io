import { api } from "../../../lib/server-api";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function PUT(request: Request, context: Context) { return api.putNote(request, (await context.params).id); }
export async function DELETE(request: Request, context: Context) { return api.deleteNote(request, (await context.params).id); }
