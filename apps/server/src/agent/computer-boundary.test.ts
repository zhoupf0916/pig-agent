import { describe,it,expect,vi,beforeEach } from 'vitest';
import type { Settings,Session } from '../types.ts';
const mock=vi.hoisted(()=>({complete:vi.fn(),execute:vi.fn(),bridge:vi.fn(()=>true)}));
vi.mock('./openai.ts',()=>({complete:mock.complete}));
vi.mock('../desktop/computer.ts',()=>({hasComputerBridge:mock.bridge,executeComputerTool:mock.execute,computerToolDefinition:{type:'function',function:{name:'computer_use'}}}));
import { runAgent } from './runtime.ts';
const settings={runtime:'pig',llmBaseUrl:'http://test.invalid',llmApiKey:'',llmModel:'fixture',workspaceRoot:'/tmp'} as Settings;
const session:Session={id:'ses_computer_boundary',title:'Boundary',status:'idle',messages:[{id:'user',role:'user',content:'Observe the desktop',createdAt:'now'}],steps:[],artifacts:[],createdAt:'now',updatedAt:'now'};
beforeEach(()=>{vi.clearAllMocks();mock.bridge.mockReturnValue(true);mock.complete.mockResolvedValue({content:'Finished',toolCalls:[]});mock.execute.mockResolvedValue('{"ok":true}');});
describe('computer tool execution boundary',()=>{
 it.each(['web','remote','stub','authorized-remote'] as const)('does not advertise or execute computer use in %s',async mode=>{
  if(mode==='web')mock.bridge.mockReturnValue(false);
  mock.complete.mockResolvedValueOnce({content:'',toolCalls:[{id:'unauthorized',name:'computer_use',arguments:'{"action":"observe"}'}]});
  const result=await runAgent({settings,session:{...session,executionTarget:mode==='remote'?'remote':'local'},signal:new AbortController().signal,emit:()=>{},memoryPins:[],allowComputer:mode==='stub'?false:undefined,authorizeTool:mode==='authorized-remote'?async()=>true:undefined});
  expect(mock.complete.mock.calls[0]?.[2].extraTools).toBeUndefined();
  expect(mock.execute).not.toHaveBeenCalled();
  expect(result.messages.some(m=>m.role==='tool'&&m.content.includes('只允许在桌面本机'))).toBe(true);
 });
 it('passes cancellation signal through an eligible local desktop invocation',async()=>{
  const signal=new AbortController().signal;
  mock.complete.mockResolvedValueOnce({content:'',toolCalls:[{id:'allowed',name:'computer_use',arguments:'{"action":"observe"}'}]});
  await runAgent({settings,session:{...session,executionTarget:'local'},signal,emit:()=>{},memoryPins:[]});
  expect(mock.complete.mock.calls[0]?.[2].extraTools[0].function.name).toBe('computer_use');
  expect(mock.execute).toHaveBeenCalledWith({action:'observe'},signal);
 });
});
