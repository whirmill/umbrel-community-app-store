/** Closed, dependency-free exports. All XLSX cells are text, never formulas. */
import { csvCell, CONTENT_LIMITS } from './content-artifacts.js';
export interface ContentTable { headers:string[]; rows:string[][] }
export function validateTable(table:ContentTable):void {
  if(!table || Object.keys(table).sort().join(',')!=='headers,rows' || !Array.isArray(table.headers)||!table.headers.length||table.headers.length>12||!Array.isArray(table.rows)||table.rows.length>2000||table.rows.some(row=>!Array.isArray(row)||row.length!==table.headers.length))throw Error('Invalid export table');
  for(const cell of [...table.headers,...table.rows.flat()])if(typeof cell!=='string'||cell.length>4096||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(cell)||/[\ud800-\udfff]/u.test(cell))throw Error('Invalid export cell');
  if(Buffer.byteLength(JSON.stringify(table))>CONTENT_LIMITS.inputBytes)throw Error('Export table too large');
}
const xml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
function crc32(data:Buffer):number {let crc=0xffffffff;for(const byte of data){crc^=byte;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
/** ZIP stored entries, deterministic timestamps, fixed member names, no input archive. */
function zip(entries:Record<string,string>):Buffer {
  const locals:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const [name,text] of Object.entries(entries)){
    const filename=Buffer.from(name),data=Buffer.from(text),crc=crc32(data),local=Buffer.alloc(30),directory=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x21,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26);
    directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x21,14);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(data.length,20);directory.writeUInt32LE(data.length,24);directory.writeUInt16LE(filename.length,28);directory.writeUInt32LE(offset,42);
    locals.push(local,filename,data);central.push(directory,filename);offset+=local.length+filename.length+data.length;
  }
  const index=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(central.length/2,8);end.writeUInt16LE(central.length/2,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,index,end]);
}
export function exportTable(table:ContentTable,format:'csv'|'xlsx'):Buffer {
  validateTable(table);const rows=[table.headers,...table.rows];let output:Buffer;
  if(format==='csv')output=Buffer.from('\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n');
  else if(format==='xlsx'){
    const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    output=zip({
      '[Content_Types].xml':'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      '_rels/.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml':`<?xml version="1.0"?><workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dati" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':`<?xml version="1.0"?><worksheet xmlns="${ns}"><sheetData>${rows.map((row,i)=>`<row r="${i+1}">${row.map((cell,j)=>`<c r="${String.fromCharCode(65+j)}${i+1}" t="inlineStr"><is><t xml:space="preserve">${xml(cell)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`,
    });
  }else throw Error('Unsupported export format');
  if(output.length>CONTENT_LIMITS.inputBytes)throw Error('Export too large');return output;
}
