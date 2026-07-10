import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildMeetingOutputAdapterManifestJson } from './intelligence/meeting-intelligence';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const forbiddenErpBrandMarkers = [['work', 'cube'].join('')];

function readWorkspaceFile(relativePath: string): string {
  return readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function expectVendorNeutral(value: unknown): void {
  const content = JSON.stringify(value).toLowerCase();
  for (const marker of forbiddenErpBrandMarkers) {
    expect(content).not.toContain(marker);
  }
}

describe('generic ERP CRM product scope', () => {
  it('keeps visible product identity independent from any ERP vendor', () => {
    const packageJson = JSON.parse(readWorkspaceFile('package.json')) as {
      description: string;
      build: { productName: string; appId: string };
    };
    const indexHtml = readWorkspaceFile('index.html');
    const electronMain = readWorkspaceFile('electron/main.ts');

    expect(packageJson.build.productName).toBe('Meeting Intelligence');
    expect(indexHtml).toContain('<title>Meeting Intelligence</title>');
    expect(electronMain).toContain("title: 'Meeting Intelligence'");

    expectVendorNeutral({
      description: packageJson.description,
      appId: packageJson.build.appId,
      productName: packageJson.build.productName,
      indexHtml,
      electronMain,
    });
  });

  it('keeps the entire packaging manifest vendor-neutral (mac extendInfo, linux desktop entry, all build config)', () => {
    // Dar alan taraması (description/appId/productName) mac extendInfo izin
    // metinleri ve linux desktop entry gibi paketleme alanlarındaki marka
    // sızıntısını kaçırır — ham dosya bütünüyle taranır.
    expectVendorNeutral(readWorkspaceFile('package.json'));
  });

  it('keeps the ERP CRM handoff adapter manifest vendor-neutral', () => {
    const manifest = JSON.parse(buildMeetingOutputAdapterManifestJson(1782741700000)) as {
      target_family: string;
      vendor_specific: boolean;
      target: string;
    };

    expect(manifest).toMatchObject({
      target_family: 'erp_crm',
      vendor_specific: false,
      target: 'Generic ERP/CRM meeting workspace',
    });
    expectVendorNeutral(manifest);
  });
});
