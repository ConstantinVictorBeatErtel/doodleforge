"""Package an existing room and prepared captures for distribution. No provider API calls."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile


def sha256(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def write_json(archive, name, value):
    archive.writestr(name, json.dumps(value, indent=2) + '\n')


def package(room, captures, output, cleanup=None):
    room, captures, output = Path(room).resolve(), Path(captures).resolve(), Path(output)
    manifest = json.loads((room/'manifest.json').read_text())
    job = json.loads((room/'job.json').read_text())
    if job['status'] != 'complete':
        raise ValueError('Only completed worlds can be packaged')
    output.mkdir(parents=True, exist_ok=True)
    cleanup_record = json.loads(Path(cleanup).read_text()) if cleanup else None
    if cleanup_record:
        cleaned_hashes = {r['cleanedSha256'] for r in cleanup_record['records']}
        if not all(i['sha256'] in cleaned_hashes for i in job['inputs']):
            raise ValueError('Cleanup provenance does not match the world inputs')
        # Generated tool paths are local implementation details, not portable provenance.
        cleanup_record['records'] = [{k:v for k,v in r.items() if k != 'generatedPath'}
                                     for r in cleanup_record['records']]
    provenance = {
        'worldId': manifest['worldId'], 'model': manifest['model'],
        'createdAt': job['createdAt'], 'completedAt': job['completedAt'],
        'inputMode': job['request']['world_prompt']['type'],
        'textPrompt': job['request']['world_prompt'].get('text_prompt'),
        'sourceFiles': [{'file': Path(i['path']).name, 'sha256': i['sha256'],
                         'bytes': i['bytes']} for i in job['inputs']],
        'peopleRemovalApplied': bool(cleanup_record),
        'cleanup': cleanup_record,
        'creditsBefore': job.get('creditsBefore'), 'creditsAfter': job.get('creditsAfter'),
        'workflow': 'docs/ROOM_CREATION_WORKFLOW.md',
        'note': 'Portable provenance. Credentials and temporary provider URLs are omitted; raw provider responses remain local.',
    }
    world_zip = output/'hackathon-room-full.zip'
    # Media is already compressed; ZIP_STORED avoids unnecessary recompression.
    with zipfile.ZipFile(world_zip, 'w', compression=zipfile.ZIP_STORED) as archive:
        for key, record in manifest['assets'].items():
            path = (room/record['path']).resolve()
            if not path.is_relative_to(room) or sha256(path) != record['sha256']:
                raise ValueError(f'Invalid asset or checksum: {key}')
            archive.write(path, record['path'])
        write_json(archive, 'manifest.json', manifest)
        write_json(archive, 'provenance.json', provenance)
        archive.write(room/'validation.json', 'validation.json')
        archive.writestr('README.txt',
                        'All returned SPZ resolutions and collider included. See provenance.json for input/cleanup history.\n'
                        'Start with assets/splat-500k.spz for a laptop viewer. Full-resolution asset: assets/splat-full_res.spz.\n'
                        'manifest.json contains relative asset paths, checksums, and coordinate metadata.\n'
                        'Physical calibration, collider alignment, and browser rendering are unverified.\n'
                        'Process: https://github.com/ConstantinVictorBeatErtel/doodleforge/blob/main/docs/ROOM_CREATION_WORKFLOW.md\n')
    capture_zip = output/'hackathon-prepared-captures.zip'
    inventory = []
    with zipfile.ZipFile(capture_zip, 'w', compression=zipfile.ZIP_STORED) as archive:
        paths = sorted((captures/'prepared').iterdir())
        if cleanup_record:
            paths += sorted((captures/'cleaned').iterdir())
        for path in paths:
            if path.suffix.lower() not in {'.jpg','.jpeg','.png','.webp','.mp4'}:
                continue
            name = str(path.relative_to(captures))
            archive.write(path, name)
            inventory.append({'file': name, 'bytes': path.stat().st_size, 'sha256': sha256(path)})
        write_json(archive, 'inventory.json', inventory)
        if cleanup_record:
            write_json(archive, 'cleanup-generation.json', cleanup_record)
        archive.writestr('README.txt',
                        f'Capture archive: {len(inventory)} media files. See inventory.json for paths and hashes.\n'
                        'World inputs: ' + ', '.join(i['file'] for i in provenance['sourceFiles']) + '\n'
                        'Original HEIC/MOV files are preserved locally. These prepared copies omit audio/device metadata.\n'
                        'Prepared copies can contain people. When included, cleaned/ contains edited inputs; see cleanup-generation.json.\n')
    for path in (world_zip, capture_zip):
        with zipfile.ZipFile(path) as archive:
            if archive.testzip() is not None:
                raise ValueError(f'Archive CRC failure: {path.name}')
    (output/'SHA256SUMS.txt').write_text(''.join(f'{sha256(p)}  {p.name}\n' for p in (world_zip,capture_zip)))
    return {'worldArchive': str(world_zip), 'captureArchive': str(capture_zip), 'captureCount': len(inventory)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--room', default='data/worlds/hackathon-room-video-01')
    parser.add_argument('--captures', default='data/captures')
    parser.add_argument('--out', default='data/releases/room-capture-2026-09-05')
    parser.add_argument('--cleanup', help='Optional cleanup-generation.json matching all submitted inputs')
    args = parser.parse_args()
    print(json.dumps(package(args.room,args.captures,args.out,args.cleanup),indent=2))
