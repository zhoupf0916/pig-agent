"""Small public-domain fixtures generated locally; no user files or network access."""
from pathlib import Path
import zipfile
import zlib
import struct
import random

root = Path('data/attachment-evidence')
root.mkdir(parents=True, exist_ok=True)
(root / 'notes.md').write_text('# Attachment acceptance\nThe marker is SHARED_CONTEXT_42.\n')
with zipfile.ZipFile(root / 'notes.docx', 'w') as archive:
    archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX_VERIFIED_42</w:t></w:r></w:p></w:body></w:document>')
content = b'BT /F1 12 Tf 20 60 Td (PDF_VERIFIED_42) Tj ET'
objects = [
    b'<< /Type /Catalog /Pages 2 0 R >>',
    b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    b'<< /Length ' + str(len(content)).encode() + b' >>\nstream\n' + content + b'\nendstream',
]
pdf = b'%PDF-1.4\n'
offsets = []
for number, obj in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf += str(number).encode() + b' 0 obj\n' + obj + b'\nendobj\n'
xref = len(pdf)
pdf += b'xref\n0 6\n0000000000 65535 f \n'
pdf += b''.join(f'{offset:010} 00000 n \n'.encode() for offset in offsets)
pdf += b'trailer << /Size 6 /Root 1 0 R >>\nstartxref\n' + str(xref).encode() + b'\n%%EOF\n'
(root / 'notes.pdf').write_bytes(pdf)
random_bytes = random.Random(42)
pixels = b''.join(b'\0' + random_bytes.randbytes(512 * 3) for _ in range(512))
def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
(root / 'large.png').write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 512, 512, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))
