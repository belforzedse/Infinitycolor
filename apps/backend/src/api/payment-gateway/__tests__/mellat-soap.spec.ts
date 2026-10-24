import http from "node:http";
import createService from "../services/mellat-v3";

const METHODS = ["bpPayRequest", "bpVerifyRequest", "bpSettleRequest", "bpInquiryRequest", "bpReversalRequest"];

/** An actual local WSDL/SOAP endpoint exercises the installed serializer and transport. */
describe("Mellat local SOAP contract", () => {
  let server: http.Server;
  let origin: string;
  let calls: Array<{ method: string; body: string }>;
  let replies: Record<string, string>;
  const originalEnv = process.env;

  const wsdl = () => `<?xml version="1.0" encoding="UTF-8"?>
  <definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    xmlns:tns="urn:mellat-test" xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:mellat-test">
    <types><xsd:schema targetNamespace="urn:mellat-test" elementFormDefault="qualified">
      ${METHODS.map((method) => `<xsd:element name="${method}"><xsd:complexType><xsd:sequence>
        ${["terminalId", "userName", "userPassword", "orderId", "amount", "localDate", "localTime", "callBackUrl", "payerId", "additionalData", "saleOrderId", "saleReferenceId"].map((field) => `<xsd:element name="${field}" type="xsd:string" minOccurs="0"/>`).join("")}
      </xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="${method}Response"><xsd:complexType><xsd:sequence><xsd:element name="return" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>`).join("")}
    </xsd:schema></types>
    ${METHODS.map((method) => `<message name="${method}Request"><part name="parameters" element="tns:${method}"/></message><message name="${method}Response"><part name="parameters" element="tns:${method}Response"/></message>`).join("")}
    <portType name="PaymentPortType">${METHODS.map((method) => `<operation name="${method}"><input message="tns:${method}Request"/><output message="tns:${method}Response"/></operation>`).join("")}</portType>
    <binding name="PaymentBinding" type="tns:PaymentPortType"><soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
      ${METHODS.map((method) => `<operation name="${method}"><soap:operation soapAction="urn:${method}"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>`).join("")}
    </binding><service name="PaymentService"><port name="PaymentPort" binding="tns:PaymentBinding"><soap:address location="${origin}/soap"/></port></service>
  </definitions>`;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "text/xml" }); response.end(wsdl()); return;
      }
      let body = "";
      request.setEncoding("utf8"); request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const method = METHODS.find((name) => body.includes(`${name}>`) || body.includes(`${name} `));
        if (!method) { response.writeHead(400); response.end(); return; }
        calls.push({ method, body });
        response.writeHead(200, { "content-type": "text/xml; charset=utf-8" });
        response.end(`<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method}Response xmlns="urn:mellat-test"><return>${replies[method] ?? "0"}</return></${method}Response></soap:Body></soap:Envelope>`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  beforeEach(() => {
    calls = []; replies = { bpPayRequest: "0,CaSeSensitiveRef" };
    process.env = { ...originalEnv, URL: origin, MELLAT_TERMINAL_ID: "1234567", MELLAT_USERNAME: "local-merchant", MELLAT_PASSWORD: "local-inert-password", MELLAT_GATEWAY_URL: `${origin}/soap?wsdl` };
  });
  afterAll(async () => {
    process.env = originalEnv;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("requests and settles through actual SOAP with exact long references", async () => {
    const service = createService({ strapi: { log: { info: jest.fn(), error: jest.fn() } } as any });
    const initiated = await service.requestPayment({ orderId: "9007199254740993", amount: 1000 });
    expect(initiated).toMatchObject({ success: true, refId: "CaSeSensitiveRef", requestedAmountIrr: 10000 });
    const tuple = { orderId: "9007199254740993", saleOrderId: "9007199254740993", saleReferenceId: "9223372036854775807" };
    expect(await service.verifyTransaction(tuple)).toMatchObject({ success: true, resCode: 0 });
    replies.bpSettleRequest = "45";
    expect(await service.settleTransaction(tuple)).toMatchObject({ success: true, resCode: 45 });
    expect(calls.map((call) => call.method)).toEqual(["bpPayRequest", "bpVerifyRequest", "bpSettleRequest"]);
    expect(calls[0].body).toContain("9007199254740993");
    expect(calls[1].body).toContain("9223372036854775807");
    expect(calls[0].body).toContain(`${origin}/api/orders/payment-callback`);
  });

  it("does not accept a malformed pay response emitted by the real SOAP transport", async () => {
    replies.bpPayRequest = "24,pretend-ref";
    const service = createService({ strapi: { log: { info: jest.fn(), error: jest.fn() } } as any });
    expect(await service.requestPayment({ orderId: "123", amount: 1000 })).toMatchObject({
      success: false, ambiguous: true, resCode: 24,
    });
    expect(calls).toHaveLength(1);
  });
});
