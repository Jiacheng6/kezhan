const fs = require('node:fs');
const path = require('node:path');
const BRAND = Object.freeze({ title: '课泊', id: 'com.kebo.app', dataName: 'Kebo', legacyDataName: 'XuexitongAssistant', legacyTitle: '学习通助手' });
function migrateProfile(appData) {
  const directory = path.join(appData, BRAND.dataName), legacy = path.join(appData, BRAND.legacyDataName);
  if (fs.existsSync(directory)) return { directory, migrated: false };
  if (!fs.existsSync(legacy)) { fs.mkdirSync(directory, {recursive:true}); return {directory,migrated:false}; }
  if (fs.lstatSync(legacy).isSymbolicLink()) throw Error('旧数据目录为链接，请先人工核对数据位置');
  const temporary = fs.mkdtempSync(path.join(appData, '.kebo-migration-'));
  try {
    fs.cpSync(legacy, temporary, { recursive:true, force:false, errorOnExist:true,
      filter(source) {
        if (fs.lstatSync(source).isSymbolicLink()) throw Error('旧数据包含链接，已保留原数据，停止自动迁移');
        return !/^(?:Singleton.*|lockfile|DevToolsActivePort)$/i.test(path.basename(source));
      },
    });
    fs.writeFileSync(path.join(temporary,'brand-migration.json'),JSON.stringify({from:BRAND.legacyDataName,to:BRAND.dataName,completed:true,at:new Date().toISOString()}));
    fs.renameSync(temporary,directory);
    return {directory,migrated:true};
  } catch (error) {
    // Exact task-owned temporary path, never the source or destination profile.
    fs.rmSync(temporary,{recursive:true,force:true});
    return {directory:legacy,migrated:false,warning:'数据迁移暂未完成，当前沿用旧数据目录：'+error.message};
  }
}
module.exports = {BRAND,migrateProfile};
