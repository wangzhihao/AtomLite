import { fail, json, withUser } from '@/lib/server/http';
import { saveUpload, UploadError } from '@/lib/server/uploads';

/** 上传一个附件（multipart/form-data，字段 file） */
export const POST = withUser(async ({ user }, req: Request) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail('请用 multipart/form-data 上传文件');
  }
  const file = form.get('file');
  if (!(file instanceof File)) return fail('缺少文件');
  try {
    return json({ attachment: saveUpload(user, file.name, new Uint8Array(await file.arrayBuffer())) }, 201);
  } catch (err) {
    if (err instanceof UploadError) return fail(err.message, err.status, 'upload');
    throw err;
  }
});
