import { Mat34Pool } from "../pools/matrix";
import { NodeTree } from "../pools/nodeTree";

export const propagateTransforms = (nodes: NodeTree, mats: Mat34Pool)=>{
    const nl = NodeTree.Layout;
    const ml = Mat34Pool.Layout;

    const nBV = nodes.getBufferViews();
    const mBV = mats.getBufferViews();
    const iGNode = new Int32Array(nBV.gpuMirrorBuffer);
    const iMNode = new Int32Array(nBV.metaBuffer);
    const iMMat  = new Int32Array(mBV.metaBuffer);

    let nodeI = 0;
    let dirtyDepth = 0;
    let stack = [nodeI];
    let pXform = [-1];
    let ranges = [];
    let isPopping = false;
    let rangeStart = -1;
    while(stack.length > 0){
        nodeI =  stack[stack.length - 1]!
        const xformI = iMNode[nodeI * nl.META_LANES + nl.M.XFORM_INDEX]!

        //Enter Node
        if(!isPopping){
            const parentXformI = pXform[pXform.length - 1]!
            let isDirty = dirtyDepth > 0
            if(xformI >= 0){ //Has Trnasform
                const dirtyFlag = iMMat[xformI * ml.META_LANES  + ml.M.DIRTY]!;
                if(dirtyDepth == 0 && dirtyFlag > 0)
                    rangeStart = nodeI;
                isDirty = isDirty || (dirtyFlag > 0)
                if(isDirty){
                    mats.updateWorld(xformI, parentXformI, false)
                }
            }
            const childI = iGNode[nodeI * nl.GPU_LANES + nl.G.CHILD]!
            if(childI >= 0){
                if(isDirty)
                    dirtyDepth++;
                const curWorldXformI = xformI >= 0 ? xformI : parentXformI
                stack.push(childI)
                pXform.push(curWorldXformI)
            }else{
                isPopping = true
            }

        //Leaving node
        }else{
            stack.pop() //We already have our I
            const sibI = iGNode[nodeI * nl.GPU_LANES + nl.G.SIB]!
            if(sibI >= 0){
                isPopping = false
                stack.push(sibI)
            }else{
                //go up a level
                pXform.pop()
                if(dirtyDepth == 1){
                    ranges.push(rangeStart)
                    ranges.push(nodeI)
                }
                dirtyDepth = dirtyDepth > 0 ? dirtyDepth - 1 : 0
            }
        }
    }
}