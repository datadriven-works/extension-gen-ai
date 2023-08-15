import { ILookmlModelExploreField, ISqlQueryCreate, IWriteQuery, Looker40SDK, user } from "@looker/sdk";
import { UtilsHelper } from "../utils/Helper";
import { LookerSQLService } from "./LookerSQLService";
import { clean } from "semver";

export interface FieldMetadata{    
    label: string;
    name: string;
    description: string;
    // type: string;    
}

export class GenerativeExploreService {
    private sql: LookerSQLService;

    public constructor(lookerSDK: Looker40SDK) {
        this.sql = new LookerSQLService(lookerSDK);
    }

    //    Method that breaks the exploreFields into chunks based on the max number of tokens
    private breakFieldsPerToken(modelFields: FieldMetadata[]): Array<FieldMetadata[]>{
        const FIXED_BREAK_PER_QUANTITY=200;
        const generatedPromptsArray = new Array<FieldMetadata[]>;
        var totalLength = modelFields.length;
        // divide by n elements
        var maxInteractions = totalLength/FIXED_BREAK_PER_QUANTITY;        
        for(let i=0; i < maxInteractions; i++){            
            generatedPromptsArray.push(modelFields.slice(i*FIXED_BREAK_PER_QUANTITY, (i+1)*FIXED_BREAK_PER_QUANTITY));
        }
        return generatedPromptsArray;
    }

    private generatePromptFields(
        modelFields: FieldMetadata[],
        userInput: string):Array<string> {        
        const generatedPromptsArray:Array<FieldMetadata[]> = this.breakFieldsPerToken(modelFields);
        const shardedPrompts:Array<string> = [];
        for(const fieldGroup of generatedPromptsArray){
            const serializedModelFields = JSON.stringify(fieldGroup);
            const generatedPrompt = `
LookerLLM Context: ${serializedModelFields}
Extract only the exact field names that are inside the LookerLLM Context that can help answer the following question.
Question: ${userInput} 

If the Question have an quantitative adjective like: "top", "bottom", "most", "least", include a "count" field or another measure that is on the LookerLLM Context.
The output format should be JSON {"fields": [field1, field2, ...]}
If there are no fields return JSON {"fields": []}.

`
            shardedPrompts.push(generatedPrompt);
        }        
        return shardedPrompts;
    }

    private generatePromptForLimits(userInput: string):string {
        const generatedPrompt = `
Based on the Question: ${userInput}
Extract the amount of records that the question wants.
The limit should be an integer from 1 to 500.
If nothing can be inferred from the question, use the default value: 500.
Examples:
Q: What are the top 10 languages?
10
Q: What are the top 50 products with the largest sales amount?
50
Q: What are the total sales per month?
500
`
        return generatedPrompt;
    }

    private removeInexistentFields(
        modelFields: FieldMetadata[],
        llmFields: Array<string>
    ): Array<string>
    {
        const cleanLLMFields: Array<string> = [];
        for(const modelField of modelFields )
        {            
            if(modelField.name!= null)
            {
                for(const llmField of llmFields)
                {            
                    if(llmField == modelField.name)
                    {
                        console.log("LLMField equals modelField.name")
                        cleanLLMFields.push(llmField);
                        break;
                    }
                }
            }
        }
        console.log("Input1 eram: " + llmFields.length + " Output: " + cleanLLMFields.length);
        return cleanLLMFields;
    }


    private async findFieldsFromLLM( 
        modelFields: FieldMetadata[],
        userInput: string): Promise<Array<string>>
    {
        // First generate prompt for Fields
        const fieldsPrompts:Array<string> = this.generatePromptFields(modelFields, userInput);
        let arraySelect: Array<string> = [];
        fieldsPrompts.forEach((promptField) =>{
            const singleLineString = UtilsHelper.escapeBreakLine(promptField);
            const subselect = `SELECT '` + singleLineString + `' AS prompt`                        
            arraySelect.push(subselect);
        });        
        // Join all the selects with union all
        const queryFields = arraySelect.join(" UNION ALL ");

        if(queryFields == null || queryFields.length == 0)
        {
            throw new Error('Could not generate field arrays on Prompt'); 
        }
        // query to run
        const queryToRunFields = `SELECT ml_generate_text_llm_result as r, ml_generate_text_status
        FROM
        ML.GENERATE_TEXT(
            MODEL llm.llm_model,
            (
            ${queryFields}
            ),
            STRUCT(
            0 AS temperature,
            1024 AS max_output_tokens,
            0 AS top_p,
            TRUE AS flatten_json_output,
            1 AS top_k));
        `;
        
        console.log("Query to Run: " + queryToRunFields);
        const results = await this.sql.execute<{
            r: string
        }>(queryToRunFields);

        var arrayLLMFields:Array<string> = [];
        for(var result of results)
        {
            try {
                if(result!=null && result.r != null && result.r.length > 0)
                {
                    var llmResultLine = JSON.parse(result.r);                
                    arrayLLMFields = arrayLLMFields.concat(llmResultLine.fields);
                }
                else{
                    console.log("Not found any fields");
                }                                
            } catch (err) {
                console.log(result);
                throw new Error('LLM result does not contain a valid JSON');
            }
        }

        //Remove fields that does not exists
        arrayLLMFields = this.removeInexistentFields(modelFields, arrayLLMFields);

        // Recheck with the LLM with the selected fields and modelFields if they are good to go or will eliminate some fields
        if(arrayLLMFields.length > 2)
        {
            // TODO: recheck with LLM if the fields makes sense;
        }

        return arrayLLMFields;
    }

    private async findLimitsFromLLM( 
        userInput: string): Promise<string>
    {
        const promptLimit = this.generatePromptForLimits(userInput);
        const singleLineString = UtilsHelper.escapeBreakLine(promptLimit);
        const subselect = `SELECT '` + singleLineString + `' AS prompt`
        // query to run
        const queryToRunFields = `SELECT ml_generate_text_llm_result as r, ml_generate_text_status
        FROM
        ML.GENERATE_TEXT(
            MODEL llm.llm_model,
            (
            ${subselect}
            ),
            STRUCT(
            0 AS temperature,
            1024 AS max_output_tokens,
            0 AS top_p,
            TRUE AS flatten_json_output,
            1 AS top_k));
        `;

        const results = await this.sql.execute<{
            r: string
        }>(queryToRunFields);
        const limitResult = UtilsHelper.firstElement(results).r;
        // validate the result
        const limitNumber = 500;
        try {
            var limitInt = parseInt(limitResult);
            if(limitInt > 0 && limitInt <= 500)
            {
                return limitResult;
            }
            else
            {
                // throw new Error("Limit not returning correct due to prompt, going to default");
                return "500";
            }
        }
        catch (err) {
            // throw new Error("Limit not returning correct due to prompt, going to default");
            return "500";
        }
    }

    

    public async generatePromptSendToBigQuery(
        modelFields: FieldMetadata[],
        userInput: string,
        inputModelName: string,
        inputViewName: string): Promise<{
        queryId: string,
        modelName: string,
        view: string,
    }> {

        
        // TODO: generate prompts for Filters
        // TODO: generate prompts for Sorts based on fields (simpler)        
        const arrayFields = await this.findFieldsFromLLM(modelFields, userInput);
        console.log("ArrayFields: " + arrayFields);
        // TODO: generate prompt for limits (easy)
        const limitFromLLM = await this.findLimitsFromLLM(userInput);
        console.log("limitFromLLM: " + limitFromLLM);

        let llmQuery: IWriteQuery;
        try {
            llmQuery = {
                model: inputModelName,
                view: inputViewName,
                fields: arrayFields,
                limit: limitFromLLM

            };
        } catch (err) {
            console.log("LLM does not contain valid JSON: ");
            throw new Error('LLM result does not contain a valid JSON');
        }
        const llmQueryResult = await this.sql.createQuery(llmQuery)
        const queryId = llmQueryResult.value.client_id;
        if (!queryId) {
            throw new Error('unable to retrieve query id from created query')
        }
        const modelName = llmQueryResult.value.model;
        const view = llmQueryResult.value.view;
        return {
            queryId,
            modelName,
            view,
        }
    }

   
}