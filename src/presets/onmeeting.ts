import * as path from 'node:path';
import { anyOf, contains, endsWith, eq, match, type ExampleMatcher } from '../schema/example-matchers';
import type { AutoDocOptions, MetadataKey } from '../types';

/**
 * The exact conventions the package was extracted from (OnMeeting). Shows how
 * every project-specific habit maps onto plain options — copy and adapt it for
 * your own project.
 *
 *   import * as shared from '@onmeeting/shared';
 *   setupSwagger(app, onmeetingPreset({
 *     publicMetadataKey: PUBLIC_METADATA_KEY,
 *     permissionsMetadataKey: REQUIRED_PERMISSIONS_METADATA_KEY,
 *     resourceMetadataKey: RESOURCE_METADATA_KEY,
 *     shared,
 *   }));
 */
export interface OnMeetingPresetInput {
  publicMetadataKey: MetadataKey;
  permissionsMetadataKey: MetadataKey;
  resourceMetadataKey: MetadataKey;
  /** `import * as shared from '@onmeeting/shared'` */
  shared?: Record<string, unknown>;
  cwd?: string;
}

export const ONMEETING_EXAMPLE_MATCHERS: ExampleMatcher[] = [
  match(eq('topic'), () => 'Weekly Sync'),
  match(eq('purpose'), () => 'Team standup'),
  match(eq('roomname'), () => 'Product Team Room'),
  match(eq('roomcode'), () => 'ABC-1234'),
  match(eq('device'), () => 'Chrome on macOS'),
  match(eq('devicename'), () => "Ahmed's MacBook Pro"),
  match(eq('browser'), () => 'Chrome'),
  match(eq('browserversion'), () => '128.0.0.0'),
  match(eq('region'), () => 'eu-west-1'),
  match(eq('gateway'), () => 'stripe'),
  match(eq('paymentmethod'), () => 'credit_card'),
  match(eq('checkkind'), () => 'usage_threshold'),
  match(eq('eventkey'), () => 'meeting.recording.completed'),
  match(eq('reviewedby'), () => '3fa85f64-5717-4562-b3fc-2c963f66afa6'),
  match(eq('accounttype'), () => 'organization'),
  match(eq('invoicenumber'), () => 'INV-2026-0001'),
  match(eq('integrationmeetingno'), () => '812 3456 7890'),
  match(eq('integrationroomcode'), () => 'ABC-1234'),
  match(eq('storagezonename'), () => 'eu-west-recordings'),
  match(eq('effectivepermissions'), () => 'manage_members'),
  match(anyOf(eq('creditamount'), eq('chargeamount'), eq('finalamount'), eq('balancebefore'), eq('balanceafter'), eq('priceafterdiscount'), eq('discountvalue')), () => '49.99'),
  match(eq('taxname'), () => 'VAT'),
  match(eq('taxvalue'), () => '14'),
  match(eq('planname'), () => 'Premium Plan'),
  match(eq('addonname'), () => 'Extra Storage'),
  match(eq('stringvalue'), () => 'sample_value'),
  match(eq('numericvalue'), () => 25),
  match(eq('booleanvalue'), () => true),
  match(eq('modeltype'), () => 'Subscription'),
  match(eq('cycle'), () => 'monthly'),
  match(eq('roletype'), () => 'custom'),
  match(eq('data'), () => '{"field":"previous_value"}'),
  match(anyOf(contains('maxusage'), contains('proration')), () => 5),
  match(endsWith('name'), () => 'Premium Plan'),
];

export function onmeetingPreset(input: OnMeetingPresetInput): AutoDocOptions {
  const cwd = input.cwd ?? process.cwd();
  return {
    path: 'api',
    title: 'OnMeeting API',
    description: 'OnMeeting video-meeting platform REST API',
    version: '1.0',
    sources: {
      roots: [path.join(cwd, 'src')],
      extraRoots: [path.join(cwd, 'node_modules', '@onmeeting', 'shared', 'dist', 'dtos')],
      includePackages: ['@onmeeting/shared'],
    },
    auth: { publicMetadataKeys: [input.publicMetadataKey], respectExplicitSecurity: false },
    rbac: { metadataKey: input.permissionsMetadataKey },
    pagination: { paramTypeNames: ['QueryOptions'] },
    dtos: { classes: input.shared ? [input.shared] : [] },
    responses: { respectExisting: false },
    resource: { metadataKey: input.resourceMetadataKey },
    examples: { baseUrl: 'https://app.onmeeting.io', dynamicKey: 'general', matchers: ONMEETING_EXAMPLE_MATCHERS },
    errors: {
      guards: 'all-providers',
      filters: 'all-providers',
      interceptors: 'all-providers',
      includePackages: ['@onmeeting/shared'],
      templateExamples: {
        key: 'autoRecording',
        valuetype: 'number',
        expectedfield: 'numericValue',
        populatedfield: 'stringValue',
        populatedfields: 'numericValue, stringValue',
        definitionid: '64f1a2b3c4d5e6f7a8b9c0d1',
        name: 'createdFrom',
        missing: 'perm_60f1a2b3c4d5e6f7a8b9c0d1, perm_60f1a2b3c4d5e6f7a8b9c0d2',
        foldertype: 'root',
      },
      crossService: {
        sharedSourceRoots: [path.resolve(cwd, '..', 'onmeeting-shared', 'src')],
        crudControllerFactory: 'createGrpcCrudController',
      },
    },
  };
}
