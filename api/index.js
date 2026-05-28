import { handleSllrRequest } from "../dist/server.js";

export default function handler(request, response) {
  return handleSllrRequest(request, response);
}
