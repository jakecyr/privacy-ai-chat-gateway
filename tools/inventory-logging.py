#!/usr/bin/env python3
"""Read-only sink inventory. This is one release gate, not a payload-leak audit."""
import argparse
import datetime
import json
import os
import pathlib
import subprocess

FILTER = 'resource.type="cloud_run_revision" (resource.labels.service_name="private-chat-gateway" OR resource.labels.service_name="private-chat-billing")'


def run(arguments):
    process = subprocess.run(['gcloud', *arguments, '--format=json', '--quiet'], capture_output=True, text=True, timeout=45)
    if process.returncode:
        raise RuntimeError('inventory_command_failed: ' + process.stderr.strip()[-1200:])
    return json.loads(process.stdout)


def covered(sink):
    if sink.get('disabled'):
        return True
    normalize = lambda value: ''.join(value.split())
    return any(not exclusion.get('disabled', False) and normalize(exclusion.get('filter', '')) == normalize(FILTER)
               for exclusion in sink.get('exclusions', []))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', action='append', required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    resources, errors, inventory = {}, [], []
    for project in args.project:
        try:
            ancestors = run(['projects', 'get-ancestors', project])
            if not any(item.get('type') == 'project' for item in ancestors):
                raise RuntimeError('project_ancestry_incomplete')
            for item in ancestors:
                kind, identifier = item['type'], item['id']
                if kind not in ('project', 'folder', 'organization'):
                    raise RuntimeError('unrecognized_ancestor_type')
                resources[(kind, identifier)] = True
        except (RuntimeError, subprocess.TimeoutExpired, ValueError, KeyError) as error:
            errors.append({'scope': project, 'error': str(error)})
    for kind, identifier in resources:
        try:
            sinks = run(['logging', 'sinks', 'list', f'--{kind}={identifier}'])
            for sink in sinks:
                required = sink.get('name') == '_Required'
                applies = kind == 'project' or sink.get('includeChildren', False)
                inventory.append({'scopeType': kind, 'scopeID': identifier, 'name': sink.get('name'),
                                  'destination': sink.get('destination'), 'requiredAuditSink': required,
                                  'appliesToProjectLogs': applies, 'excluded': covered(sink),
                                  'disabled': sink.get('disabled', False), 'filter': sink.get('filter', ''),
                                  'exclusions': sink.get('exclusions', [])})
        except (RuntimeError, subprocess.TimeoutExpired, ValueError, KeyError) as error:
            errors.append({'scope': f'{kind}/{identifier}', 'error': str(error)})
    gaps = [sink for sink in inventory if sink['appliesToProjectLogs'] and not sink['requiredAuditSink'] and not sink['excluded']]
    routing_verified = not errors and not gaps and bool(inventory)
    report = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'projects': args.project,
              'expectedExclusion': FILTER, 'sinks': inventory, 'errors': errors,
              'routingExclusionsVerified': routing_verified,
              'fullLoggingReleaseGatePassed': False,
              'remainingEvidence': ['destination/bucket/export inventory and access', 'positive control',
                                    'synthetic release traffic', 'payload marker and request-row scans after delivery lag',
                                    'Trace, Error Reporting, device and CI scans', 'content-free signed release attestation']}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, 'w') as handle:
        json.dump(report, handle, indent=2)
        handle.write('\n')
    print(json.dumps({'resources': len(resources), 'sinks': len(inventory), 'errors': len(errors),
                      'unprotectedSinks': len(gaps), 'routingExclusionsVerified': routing_verified,
                      'fullLoggingReleaseGatePassed': False}))
    return 0 if routing_verified else 1


if __name__ == '__main__':
    raise SystemExit(main())
